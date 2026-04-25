require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const NodeCache = require('node-cache');
const path = require('path');

const app = express();
const cache = new NodeCache({ stdTTL: 600 });
const PORT = process.env.PORT || 3000;
const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY_backend || process.env.GOOGLE_PLACES_API_KEY || '';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ════════════════════════════════════════════════════════════════
// 移植自 scoring.py — 完整保留原版公式
// 限制：Google Places API 只給 5 則評論，無法取得真實 7/14 天快照
// 解法：用 5 則評論的時間跨度推算 recent_growth 與 previous_growth
// ════════════════════════════════════════════════════════════════

// ── 基礎工具函式（對應 scoring.py）─────────────────────────────
function clamp(value, min = 0.0, max = 1.0) {
  return Math.max(min, Math.min(max, value));
}

function normalize(value, maxValue) {
  if (maxValue <= 0) return 0.0;
  return clamp(value / maxValue);
}

function log1p(x) {
  return Math.log(1 + x);
}

// ── freshness_score（對應 compute_freshness_score）──────────────
function computeFreshnessScore(totalReviews) {
  if (!totalReviews) return 0.0;
  if (totalReviews < 80)  return 1.0;
  if (totalReviews < 200) return 0.6;
  return 0.2;
}

// ── trend_score（對應 compute_trend_score）──────────────────────
function computeTrendScore({ rating, totalReviews, recentGrowth, previousGrowth }) {
  const MAX_RECENT_GROWTH = 50;
  const MAX_GROWTH_RATE   = 3.0;

  rating        = rating        || 0.0;
  totalReviews  = totalReviews  || 0;
  recentGrowth  = Math.max(recentGrowth  || 0, 0);
  previousGrowth = Math.max(previousGrowth || 0, 0);

  const growthRate              = recentGrowth / Math.max(previousGrowth, 1);
  const normalizedRecentGrowth  = normalize(recentGrowth, MAX_RECENT_GROWTH);
  const normalizedGrowthRate    = normalize(growthRate, MAX_GROWTH_RATE);
  const normalizedRecentVolume  = normalize(log1p(recentGrowth), log1p(MAX_RECENT_GROWTH));
  const ratingScore             = clamp(rating / 5.0);
  const freshnessScore          = computeFreshnessScore(totalReviews);
  const momentumScore           = normalize(
    recentGrowth * 0.6 + previousGrowth * 0.4,
    MAX_RECENT_GROWTH
  );

  const trendScore = (
    0.35 * normalizedRecentGrowth +
    0.20 * normalizedGrowthRate   +
    0.15 * normalizedRecentVolume +
    0.10 * ratingScore            +
    0.10 * freshnessScore         +
    0.10 * momentumScore
  ) * 100;

  return {
    trendScore:     parseFloat(trendScore.toFixed(2)),
    growthRate:     parseFloat(growthRate.toFixed(2)),
    freshnessScore: parseFloat(freshnessScore.toFixed(2)),
    momentumScore:  parseFloat(momentumScore.toFixed(2)),
  };
}

// ── promotion_signal（對應 compute_promotion_signal）────────────
function computePromotionSignal({ recentGrowth, previousGrowth, rating, totalReviews }) {
  recentGrowth   = Math.max(recentGrowth   || 0, 0);
  previousGrowth = Math.max(previousGrowth || 0, 0);
  rating         = rating        || 0.0;
  totalReviews   = totalReviews  || 0;

  const avgPrevious = Math.max(previousGrowth, 1);
  const spikeRatio  = recentGrowth / avgPrevious;
  const spikeRatioScore = Math.min(spikeRatio / 4.0, 1.0);

  let highRatingClusterScore;
  if (rating >= 4.7 && recentGrowth >= 15 && totalReviews < 200) {
    highRatingClusterScore = 1.0;
  } else if (rating >= 4.5 && recentGrowth >= 10) {
    highRatingClusterScore = 0.6;
  } else {
    highRatingClusterScore = 0.2;
  }

  // 無文字分析資料，保持原版預設值
  const reviewTextSimilarityScore = 0.2;
  const shortTextRatioScore       = 0.2;

  let reviewerConcentrationScore;
  if (totalReviews < 100 && recentGrowth >= 20) {
    reviewerConcentrationScore = 1.0;
  } else if (totalReviews < 200 && recentGrowth >= 15) {
    reviewerConcentrationScore = 0.6;
  } else {
    reviewerConcentrationScore = 0.2;
  }

  const score = (
    0.35 * spikeRatioScore             +
    0.20 * highRatingClusterScore      +
    0.15 * reviewTextSimilarityScore   +
    0.15 * shortTextRatioScore         +
    0.15 * reviewerConcentrationScore
  );

  let level, reason;
  if (score >= 0.75) {
    level  = 'high';
    reason = '近期聲量成長速度明顯高於過去平均，且高分評價集中，可能受活動或導流影響';
  } else if (score >= 0.45) {
    level  = 'medium';
    reason = '近期聲量活躍度偏高，可能有行銷活動或外部導流介入';
  } else {
    level  = 'low';
    reason = '目前未見明顯暴漲訊號';
  }

  return {
    promotionSignalScore: parseFloat((score * 100).toFixed(2)),
    promotionSignalLevel: level,
    promotionSignalReason: reason,
    spikeRatio: parseFloat(spikeRatio.toFixed(2)),
  };
}

// ── _signal_from_place（對應 explore.py，即時快照版）────────────
function signalFromPlace({ rating, totalReviews }) {
  rating       = parseFloat(rating)       || 0;
  totalReviews = parseInt(totalReviews)   || 0;

  let score = 0.0;
  const reasons = [];

  if (rating >= 4.7) {
    score += 0.30;
    reasons.push('評分偏高');
  } else if (rating >= 4.5) {
    score += 0.18;
  }

  if (totalReviews >= 20 && totalReviews <= 120) {
    score += 0.30;
    reasons.push('評價數落在容易被短期活動放大的區間');
  } else if (totalReviews >= 121 && totalReviews <= 250) {
    score += 0.15;
  }

  if (rating >= 4.7 && totalReviews <= 80) {
    score += 0.25;
    reasons.push('高分且評價量不高');
  } else if (rating >= 4.5 && totalReviews <= 150) {
    score += 0.15;
  }

  let level, reason;
  if (score >= 0.75) {
    level  = 'high';
    reason = reasons.length ? reasons.join('、') : '近期評價表現偏強，可能有人為行銷活動推升評價';
  } else if (score >= 0.45) {
    level  = 'medium';
    reason = reasons.length ? reasons.join('、') : '近期評價活躍，可能受活動或導流影響';
  } else {
    level  = 'low';
    reason = '目前未見明顯推升訊號';
  }

  return { snapshotScore: parseFloat((score * 100).toFixed(2)), snapshotLevel: level, snapshotReason: reason };
}

// ════════════════════════════════════════════════════════════════
// 主分析函式：只回傳數字事實，不做價值判斷
// 讓使用者自行解讀數字含義
// ════════════════════════════════════════════════════════════════
function analyzeReviews(reviews = [], totalRatings = 0, rating = 0, photoCount = 0) {
  const now = Date.now() / 1000;
  const sevenDays  =  7 * 24 * 3600;
  const thirtyDays = 30 * 24 * 3600;

  // 排序：最新優先，過濾無時間戳
  const sorted = [...reviews]
    .filter(r => r.time)
    .sort((a, b) => b.time - a.time);

  // ── 最新 5 則評論的星數分析 ───────────────────────────────────
  const recentRatings    = sorted.map(r => r.rating || 0);
  const recentAvgRating  = recentRatings.length
    ? parseFloat((recentRatings.reduce((a, b) => a + b, 0) / recentRatings.length).toFixed(1))
    : null;

  // 星數分佈（1–5星各幾則）
  const ratingDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  recentRatings.forEach(r => { if (r >= 1 && r <= 5) ratingDistribution[r]++; });

  // 無評論資料
  if (sorted.length === 0) {
    return {
      // 聲量數字
      estimatedDailyRate:    0,
      estimatedWeeklyVolume: 0,
      spikeRatio:            0,
      velocityTrend:         'unknown',
      // 評分數字
      overallRating:         rating,
      totalRatings,
      recentAvgRating:       null,
      ratingDistribution,
      ratingDelta:           null,  // 近期平均 vs 整體平均的差
      // 新鮮度
      freshnessScore:        computeFreshnessScore(totalRatings),
      // 原始資料
      recentReviews:         [],
      newestReviewDaysAgo:   null,
      // 前端相容
      viralScore:            0,
      suspicionScore:        0,
      suspicionRaw:          0,
      signals:               [],
    };
  }

  // ── 時間計算 ─────────────────────────────────────────────────
  const newest   = sorted[0].time;
  const oldest   = sorted[sorted.length - 1].time;
  const spanDays = Math.max((newest - oldest) / 86400, 0.5);
  const newestDaysAgo = parseFloat(((now - newest) / 86400).toFixed(1));

  const allWithin7Days = sorted.every(r => (now - r.time) < sevenDays);
  const recentCount    = sorted.filter(r => (now - r.time) < sevenDays).length;

  // ── 聲量速度推算 ─────────────────────────────────────────────
  const velocityPerDay = sorted.length / spanDays;
  const effectiveDailyRate = allWithin7Days
    ? velocityPerDay
    : (recentCount > 0 ? recentCount / Math.min(newestDaysAgo + 1, 7) : velocityPerDay);

  const estimatedWeeklyVolume  = Math.round(effectiveDailyRate * 7);
  const estimatedPreviousGrowth = Math.max(Math.round(estimatedWeeklyVolume * 0.3), 1);
  const spikeRatio = parseFloat((estimatedWeeklyVolume / estimatedPreviousGrowth).toFixed(1));

  // 速度趨勢：加速 / 持平 / 減速（簡單用 spike ratio 判斷）
  const velocityTrend = spikeRatio >= 2 ? 'accelerating' : spikeRatio >= 0.8 ? 'stable' : 'decelerating';

  // ── 評分差距（近期 vs 整體）─────────────────────────────────
  const ratingDelta = recentAvgRating !== null
    ? parseFloat((recentAvgRating - rating).toFixed(1))
    : null;

  // ── 原版評分函式（保留供排序用，不顯示給用戶）───────────────
  const trend = computeTrendScore({
    rating,
    totalReviews:   totalRatings,
    recentGrowth:   estimatedWeeklyVolume,
    previousGrowth: estimatedPreviousGrowth,
  });

  const promotion = computePromotionSignal({
    recentGrowth:   estimatedWeeklyVolume,
    previousGrowth: estimatedPreviousGrowth,
    rating,
    totalReviews:   totalRatings,
  });

  // viralScore 僅用於地圖標記大小與排序，不顯示文字判斷
  const viralScore = Math.round(trend.trendScore);

  return {
    // ── 聲量數字 ──────────────────────────────────────────────
    estimatedDailyRate:    parseFloat(effectiveDailyRate.toFixed(2)),  // 估計每日評論數
    estimatedWeeklyVolume,                                              // 估計近7天評論數
    spikeRatio,                                                         // 近期 vs 前期速度倍數
    velocityTrend,                                                      // accelerating / stable / decelerating

    // ── 評分數字 ──────────────────────────────────────────────
    overallRating:   rating,
    totalRatings,
    recentAvgRating,
    ratingDelta,
    ratingDistribution,

    // ── 照片數量 ──────────────────────────────────────────────
    photoCount,           // API 回傳照片數（最多10）
    photoAtMax: photoCount >= 10,  // true = 達上限，實際可能更多
    photoDensity: totalRatings > 0  // 照片數 / 總評論數 × 100
      ? parseFloat((photoCount / totalRatings * 100).toFixed(2))
      : 0,

    // ── 新鮮度 ────────────────────────────────────────────────
    freshnessScore: computeFreshnessScore(totalRatings),
    newestReviewDaysAgo: newestDaysAgo,

    // ── 原始評論 ──────────────────────────────────────────────
    recentReviews: sorted.slice(0, 5),

    // ── 前端排序用 ────────────────────────────────────────────
    viralScore,
    suspicionScore: promotion.promotionSignalScore,
    suspicionRaw:   parseFloat((promotion.promotionSignalScore / 10).toFixed(1)),
    signals:        [],
  };
}

// ════════════════════════════════════════════════════════════════
// Routes
// ════════════════════════════════════════════════════════════════
const EXCLUDE_TYPES = ['lodging', 'hotel', 'motel', 'resort_hotel'];

// 提供前端 Maps API Key（從環境變數讀取，不硬寫在 HTML）
app.get('/api/maps-key', (req, res) => {
  const mapsKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY || '';
  res.json({ key: mapsKey });
});

app.get('/api/trending', async (req, res) => {
  const { lat, lng, radius = 2000, type = 'all' } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'Missing lat/lng' });

  const cacheKey = `trending_${lat}_${lng}_${radius}_${type}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    // 完整 keyword 清單（config.py 原版 + 自訂補充）
    const ALL_KEYWORDS_EN = [
      'restaurant', 'cafe', 'coffee', 'brunch', 'breakfast', 'lunch', 'dinner',
      'noodle', 'ramen', 'hotpot', 'barbecue', 'bbq', 'steak', 'burger', 'pizza',
      'sushi', 'japanese', 'korean', 'thai', 'vietnamese', 'chinese', 'taiwanese',
      'dessert', 'bakery', 'bistro', 'bar', 'izakaya', 'dim sum', 'vegetarian',
      'vegan', 'seafood',
      'pub', 'cocktail', 'wine', 'beer', 'bento', 'snack', 'takeaway',
      'pastry', 'sandwich', 'salad', 'grill', 'buffet', 'omakase',
      'teppanyaki', 'shabu', 'yakiniku', 'curry', 'pho', 'banh mi',
    ];
    const ALL_KEYWORDS_ZH = [
      '餐廳', '咖啡廳', '早午餐', '早餐店', '麵店', '拉麵', '火鍋', '燒肉',
      '牛排', '壽司', '日式', '韓式', '泰式', '越式', '中式', '台式',
      '甜點', '麵包店', '酒吧', '居酒屋', '港式', '素食', '海鮮',
      '小吃', '便當', '外帶', '燒烤', '炸物', '丼飯', '義大利麵', '披薩',
      '漢堡', '三明治', '鍋物', '涮涮鍋', '鐵板燒', '咖哩', '定食',
      '創意料理', '無菜單', '餐酒館', '輕食', '下午茶', '甜品', '冰淇淋',
    ];

    // 各類型對應的 keyword 子集 + type
    const typeMap = {
      restaurant:    { keywords: ['restaurant', 'bistro', 'lunch', 'dinner', 'grill', 'buffet', 'omakase', 'teppanyaki', 'curry', 'shabu', 'yakiniku', '餐廳', '中式', '台式', '日式', '韓式', '泰式', '越式', '港式', '牛排', '燒肉', '丼飯', '義大利麵', '創意料理', '無菜單', '餐酒館', '鐵板燒', '定食'], type: 'restaurant' },
      cafe:          { keywords: ['cafe', 'coffee', 'brunch', 'pastry', '咖啡廳', '早午餐', '輕食', '下午茶'], type: 'cafe' },
      bar:           { keywords: ['bar', 'izakaya', 'pub', 'cocktail', 'wine', 'beer', '酒吧', '居酒屋', '餐酒館'], type: 'bar' },
      bakery:        { keywords: ['bakery', 'breakfast', 'dessert', 'pastry', 'sandwich', '早餐店', '麵包店', '甜點', '甜品', '下午茶', '冰淇淋'], type: 'bakery' },
      meal_takeaway: { keywords: ['noodle', 'ramen', 'bento', 'snack', 'takeaway', 'pho', '麵店', '拉麵', '小吃', '便當', '外帶', '炸物'], type: 'meal_takeaway' },
    };

    // ── Step 1：keyword 搜尋 ────────────────────────────────────
    let places = [];
    if (type === 'all') {
      const representativeKeywords = [
        'restaurant', 'cafe', 'coffee', 'brunch', 'bar', 'bakery', 'ramen',
        'hotpot', 'sushi', 'dessert', 'bistro', 'izakaya', 'bbq', 'buffet',
        '餐廳', '咖啡廳', '早午餐', '火鍋', '酒吧', '甜點', '燒肉', '早餐店',
        '小吃', '麵店', '下午茶', '餐酒館', '無菜單', '丼飯'
      ];
      const searches = await Promise.all(
        representativeKeywords.map(kw =>
          axios.get('https://maps.googleapis.com/maps/api/place/nearbysearch/json', {
            params: { location: `${lat},${lng}`, radius, keyword: kw, key: GOOGLE_API_KEY, language: 'zh-TW' }
          })
        )
      );
      const seen = new Set();
      searches.forEach(r => {
        (r.data.results || []).forEach(p => {
          if (!seen.has(p.place_id)) { seen.add(p.place_id); places.push(p); }
        });
      });
    } else {
      const { keywords, type: t } = typeMap[type] || typeMap.restaurant;
      const searches = await Promise.all(
        keywords.map(kw =>
          axios.get('https://maps.googleapis.com/maps/api/place/nearbysearch/json', {
            params: { location: `${lat},${lng}`, radius, keyword: kw, type: t, key: GOOGLE_API_KEY, language: 'zh-TW' }
          })
        )
      );
      const seen = new Set();
      searches.forEach(r => {
        (r.data.results || []).forEach(p => {
          if (!seen.has(p.place_id)) { seen.add(p.place_id); places.push(p); }
        });
      });
    }

    // ── Step 2：基本過濾 + 距離限制 ─────────────────────────────
    const toRad = d => d * Math.PI / 180;
    const distanceKm = (lat1, lng1, lat2, lng2) => {
      const R = 6371;
      const dLat = toRad(lat2 - lat1);
      const dLng = toRad(lng2 - lng1);
      const a = Math.sin(dLat/2) ** 2 +
                Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    };
    const radiusKm = radius / 1000;

    const basePlaces = places
      .filter(p => !p.types?.some(t => EXCLUDE_TYPES.includes(t)))
      .filter(p => p.rating && p.user_ratings_total)
      .filter(p => (p.user_ratings_total || 0) >= 5)
      .filter(p => {
        const pLat = p.geometry?.location?.lat;
        const pLng = p.geometry?.location?.lng;
        if (!pLat || !pLng) return false;
        return distanceKm(parseFloat(lat), parseFloat(lng), pLat, pLng) <= radiusKm;
      });

    // ── Step 3：四種模式各自預篩選，合併去重取前 30 間 ──────────
    const pickByMode = (places, modeKey, limit = 20) => {
      const sorted = [...places].sort((a, b) => {
        if (modeKey === 'viral') {
          const sA = (a.rating || 0) * 10 + Math.min(a.user_ratings_total || 0, 500) * 0.01 + ((a.user_ratings_total || 0) < 300 ? 5 : 0);
          const sB = (b.rating || 0) * 10 + Math.min(b.user_ratings_total || 0, 500) * 0.01 + ((b.user_ratings_total || 0) < 300 ? 5 : 0);
          return sB - sA;
        }
        if (modeKey === 'topRated' || modeKey === 'recentRating') {
          return (b.rating || 0) - (a.rating || 0);
        }
        if (modeKey === 'steady') {
          const isOldA = (a.user_ratings_total || 0) > 500 ? 10 : 0;
          const isOldB = (b.user_ratings_total || 0) > 500 ? 10 : 0;
          return ((b.rating || 0) * 5 + isOldB) - ((a.rating || 0) * 5 + isOldA);
        }
        return 0;
      });
      return sorted.slice(0, limit).map(p => p.place_id);
    };

    // 各模式選出的 place_id
    const viralIds      = new Set(pickByMode(basePlaces, 'viral'));
    const topRatedIds   = new Set(pickByMode(basePlaces, 'topRated'));
    const recentIds     = new Set(pickByMode(basePlaces, 'recentRating'));
    // 穩定成長：總評論數 / 近期週速度 > 52（推估存在超過一年）
    // 近期速度越快相對總量越小 → 行銷刷評的店自然被過濾
    const steadyIds     = new Set(pickByMode(
      basePlaces.filter(p => (p.user_ratings_total || 0) >= 200),
      'steady'
    ));

    // 合併所有需要的 place_id（去重）
    const allIds = new Set([...viralIds, ...topRatedIds, ...recentIds, ...steadyIds]);
    const placesToFetch = basePlaces.filter(p => allIds.has(p.place_id));

    // ── Step 4：打 Details API ────────────────────────────────────
    const detailed = await Promise.all(
      placesToFetch.map(async place => {
        try {
          const detailRes = await axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
            params: {
              place_id: place.place_id,
              fields: 'name,rating,user_ratings_total,reviews,photos,formatted_address,opening_hours,price_level,types,geometry',
              key: GOOGLE_API_KEY,
              language: 'zh-TW',
              reviews_sort: 'newest'
            }
          });
          const d = detailRes.data.result;
          if (!d) return null;
          if (d.types?.some(t => EXCLUDE_TYPES.includes(t))) return null;

          const photoCount = (d.photos || []).length;
          const analysis = analyzeReviews(d.reviews || [], d.user_ratings_total || 0, d.rating || 0, photoCount);

          return {
            place_id:     place.place_id,
            name:         d.name,
            rating:       d.rating,
            totalRatings: d.user_ratings_total,
            address:      d.formatted_address,
            priceLevel:   d.price_level,
            types:        d.types,
            lat:          d.geometry?.location?.lat,
            lng:          d.geometry?.location?.lng,
            photoRef:     d.photos?.[0]?.photo_reference || null,
            photoCount,
            isOpen:       d.opening_hours?.open_now,
            analysis,
          };
        } catch { return null; }
      })
    );

    const allDetailed = detailed.filter(Boolean);

    // ── Step 5：四種模式各自排序 ─────────────────────────────────
    const sortByMode = (data, modeKey) => {
      const ids = modeKey === 'viral' ? viralIds
                : modeKey === 'topRated' ? topRatedIds
                : modeKey === 'recentRating' ? recentIds
                : steadyIds;

      let filtered = data.filter(p => ids.has(p.place_id));

      // 穩定成長：額外過濾「總評論數 / 近期週速度 > 52」
      // 代表即使以近期速度估算，也至少存在超過一年
      if (modeKey === 'steady') {
        filtered = filtered.filter(p => {
          const weeklyRate = p.analysis.estimatedWeeklyVolume || 0;
          const total = p.totalRatings || 0;
          if (weeklyRate <= 0) return true;  // 速度為 0 的老店保留
          return (total / weeklyRate) >= 52;
        });
      }

      return filtered.sort((a, b) => {
          if (modeKey === 'viral')
            return (b.analysis.estimatedDailyRate || 0) - (a.analysis.estimatedDailyRate || 0);
          if (modeKey === 'topRated')
            return (b.rating || 0) - (a.rating || 0);
          if (modeKey === 'recentRating')
            return (b.analysis.recentAvgRating || 0) - (a.analysis.recentAvgRating || 0);
          if (modeKey === 'steady') {
            // 排序依據：評分 × log(總評論數)，口碑好且有歷史的店排前面
            const scoreA = (a.rating || 0) * Math.log(a.totalRatings || 1);
            const scoreB = (b.rating || 0) * Math.log(b.totalRatings || 1);
            return scoreB - scoreA;
          }
          return 0;
        });
    };

    const result = {
      viral:        sortByMode(allDetailed, 'viral'),
      topRated:     sortByMode(allDetailed, 'topRated'),
      recentRating: sortByMode(allDetailed, 'recentRating'),
      steady:       sortByMode(allDetailed, 'steady'),
    };

    cache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: '無法取得資料，請確認 API Key 是否正確' });
  }
});

app.get('/api/photo', async (req, res) => {
  const { ref, maxwidth = 400 } = req.query;
  if (!ref) return res.status(400).send('Missing ref');
  try {
    const photoRes = await axios.get('https://maps.googleapis.com/maps/api/place/photo', {
      params: { photoreference: ref, maxwidth, key: GOOGLE_API_KEY },
      responseType: 'stream'
    });
    photoRes.data.pipe(res);
  } catch { res.status(404).send('Photo not found'); }
});

app.get('/api/place/:placeId', async (req, res) => {
  const { placeId } = req.params;
  const cacheKey = `place_${placeId}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const detailRes = await axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
      params: {
        place_id: placeId,
        fields: 'name,rating,user_ratings_total,reviews,photos,formatted_address,opening_hours,price_level,website,formatted_phone_number,geometry',
        key: GOOGLE_API_KEY,
        language: 'zh-TW',
        reviews_sort: 'newest'
      }
    });
    const d = detailRes.data.result;
    const photoCount = (d.photos || []).length;
    const analysis = analyzeReviews(d.reviews || [], d.user_ratings_total || 0, d.rating || 0, photoCount);
    const result = { ...d, photoCount, analysis };
    cache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: '無法取得店家詳情' });
  }
});

app.listen(PORT, () => {
  console.log(`🔥 Viral Spots 伺服器運行中: http://localhost:${PORT}`);
});
