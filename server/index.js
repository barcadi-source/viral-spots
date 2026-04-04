require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const NodeCache = require('node-cache');
const path = require('path');

const app = express();
const cache = new NodeCache({ stdTTL: 600 });
const PORT = process.env.PORT || 3000;
const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

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

app.get('/api/trending', async (req, res) => {
  const { lat, lng, radius = 2000, type = 'all' } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'Missing lat/lng' });

  const cacheKey = `trending_${lat}_${lng}_${radius}_${type}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const typeMap = {
      restaurant:    'restaurant',
      cafe:          'cafe',
      bar:           'bar',
      bakery:        'bakery',
      meal_takeaway: 'meal_takeaway',
    };

    let places = [];
    if (type === 'all') {
      const searches = await Promise.all(
        ['restaurant', 'cafe', 'bar', 'meal_takeaway', 'bakery'].map(t =>
          axios.get('https://maps.googleapis.com/maps/api/place/nearbysearch/json', {
            params: { location: `${lat},${lng}`, radius, type: t, key: GOOGLE_API_KEY, language: 'zh-TW' }
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
      const res2 = await axios.get('https://maps.googleapis.com/maps/api/place/nearbysearch/json', {
        params: { location: `${lat},${lng}`, radius, type: typeMap[type] || 'restaurant', key: GOOGLE_API_KEY, language: 'zh-TW' }
      });
      places = res2.data.results || [];
    }

    // 排除飯店
    places = places.filter(p => !p.types?.some(t => EXCLUDE_TYPES.includes(t)));

    const detailed = await Promise.all(
      places.slice(0, 15).map(async place => {
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
            place_id:   place.place_id,
            name:       d.name,
            rating:     d.rating,
            totalRatings: d.user_ratings_total,
            address:    d.formatted_address,
            priceLevel: d.price_level,
            types:      d.types,
            lat:        d.geometry?.location?.lat,
            lng:        d.geometry?.location?.lng,
            photoRef:   d.photos?.[0]?.photo_reference || null,
            photoCount,
            isOpen:     d.opening_hours?.open_now,
            analysis,
          };
        } catch { return null; }
      })
    );

    // 排序：promotion score 優先，trend score 次之
    const result = detailed
      .filter(Boolean)
      .sort((a, b) =>
        (b.analysis.promotionSignalScore * 0.6 + b.analysis.trendScore * 0.4) -
        (a.analysis.promotionSignalScore * 0.6 + a.analysis.trendScore * 0.4)
      );

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
