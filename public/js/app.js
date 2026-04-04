// ── State ──────────────────────────────────────────────────────
let map, marker, searchCircle;
let currentLat = null, currentLng = null;
let currentRadius = 1000;
let currentType = 'all';
let allResults = [];

// ── Map Init ───────────────────────────────────────────────────
function initMap() {
  map = new google.maps.Map(document.getElementById('map'), {
    center: { lat: 25.0330, lng: 121.5654 },
    zoom: 14,
    disableDefaultUI: false,
    zoomControl: true,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
  });

  map.addListener('click', e => {
    setMapCenter(e.latLng.lat(), e.latLng.lng());
  });
}

function setMapCenter(lat, lng) {
  currentLat = lat;
  currentLng = lng;

  if (marker) marker.setMap(null);
  // 大頭針 SVG（與店家紅點區分）
  const pinSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="40" viewBox="0 0 32 40">
    <path d="M16 0C9.373 0 4 5.373 4 12c0 9 12 28 12 28S28 21 28 12C28 5.373 22.627 0 16 0z" fill="#00e5ff" stroke="#fff" stroke-width="2"/>
    <circle cx="16" cy="12" r="5" fill="#fff"/>
  </svg>`;
  const markerIcon = {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(pinSvg),
    scaledSize: new google.maps.Size(32, 40),
    anchor: new google.maps.Point(16, 40),
  };
  marker = new google.maps.Marker({
    position: { lat, lng },
    map,
    draggable: true,
    icon: markerIcon,
    title: '搜尋中心點（可拖曳）',
    zIndex: 100
  });

  marker.addListener('dragend', e => {
    currentLat = e.latLng.lat();
    currentLng = e.latLng.lng();
    if (searchCircle) searchCircle.setCenter({ lat: currentLat, lng: currentLng });
    document.getElementById('locationText').textContent = `${currentLat.toFixed(4)}, ${currentLng.toFixed(4)}`;
  });

  // Circle
  if (searchCircle) searchCircle.setMap(null);
  searchCircle = new google.maps.Circle({
    map,
    center: { lat, lng },
    radius: currentRadius,
    fillColor: '#ff3b3b',
    fillOpacity: 0.05,
    strokeColor: '#ff3b3b',
    strokeOpacity: 0.4,
    strokeWeight: 1,
    clickable: false,
  });

  map.panTo({ lat, lng });

  document.getElementById('locationText').textContent = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  document.getElementById('btnSearch').disabled = false;
}

// ── Geolocation ─────────────────────────────────────────────────
function locateMe() {
  const btn = document.getElementById('btnLocate');
  btn.textContent = '定位中...';
  btn.disabled = true;

  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude: lat, longitude: lng } = pos.coords;
      setMapCenter(lat, lng);
      map.setZoom(15);
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4"/><circle cx="12" cy="12" r="9" opacity=".3"/></svg><span>已定位</span>`;
      btn.disabled = false;
    },
    err => {
      alert('無法取得位置，請確認瀏覽器定位權限');
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4"/><circle cx="12" cy="12" r="9" opacity=".3"/></svg><span>定位我的位置</span>`;
      btn.disabled = false;
    }
  );
}

// ── Radius / Type ───────────────────────────────────────────────
function setRadius(el) {
  document.querySelectorAll('.radius-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  currentRadius = parseInt(el.dataset.radius);
  if (searchCircle) searchCircle.setRadius(currentRadius);
}

function setType(el) {
  document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  currentType = el.dataset.type;
}

// ── Mobile detection ────────────────────────────────────────────
const isMobile = () => window.innerWidth <= 768;

// ── Search ──────────────────────────────────────────────────────
async function searchTrending() {
  if (!currentLat || !currentLng) return;

  showLoading(true);
  clearMapMarkers();

  try {
    const res = await fetch(`/api/trending?lat=${currentLat}&lng=${currentLng}&radius=${currentRadius}&type=${currentType}`);
    if (!res.ok) throw new Error(await res.text());
    allResults = await res.json();
    // 預設依近期評論速度排序
    allResults.sort((a, b) => (b.analysis.estimatedDailyRate || 0) - (a.analysis.estimatedDailyRate || 0));
    renderResults(allResults);
    renderMapMarkers(allResults);

    // 手機版：顯示浮標
    if (isMobile()) {
      const badge = document.getElementById('mobileResultBadge');
      badge.style.display = 'flex';
      document.getElementById('mobileResultCount').textContent = `📍 ${allResults.length} 間店家`;
    }
  } catch (e) {
    document.getElementById('results').innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>搜尋失敗：${e.message}</p></div>`;
  } finally {
    showLoading(false);
  }
}

// ── Render Results ──────────────────────────────────────────────
function renderResults(data) {
  const container = document.getElementById('results');
  const mobileContainer = document.getElementById('mobileResults');
  const title = document.getElementById('resultsTitle');
  const mobileTitle = document.getElementById('mobileResultsTitle');

  if (!data.length) {
    const empty = `<div class="empty-state"><div class="empty-icon">🔍</div><p>此範圍內未找到店家</p></div>`;
    container.innerHTML = empty;
    if (mobileContainer) mobileContainer.innerHTML = empty;
    title.textContent = '找不到結果';
    if (mobileTitle) mobileTitle.textContent = '找不到結果';
    return;
  }

  const titleText = `找到 ${data.length} 間店家`;
  title.textContent = titleText;
  if (mobileTitle) mobileTitle.textContent = titleText;
  container.innerHTML = '';
  if (mobileContainer) mobileContainer.innerHTML = '';

  data.forEach((place, i) => {
    const card = createCard(place, i);
    container.appendChild(card);
    // 手機版也渲染一份
    if (mobileContainer) {
      const mobileCard = createCard(place, i);
      mobileContainer.appendChild(mobileCard);
    }
    setTimeout(() => card.style.animationDelay = '0ms', i * 50);
  });
}

function createCard(place, index) {
  const { analysis } = place;
  const div = document.createElement('div');
  div.className = 'place-card';
  div.style.animationDelay = `${index * 60}ms`;
  div.onclick = () => openModal(place);

  const typeEmoji = getTypeEmoji(place.types);
  const imgEl = place.photoRef
    ? `<img class="card-img" src="/api/photo?ref=${place.photoRef}&maxwidth=150" alt="${place.name}" loading="lazy">`
    : `<div class="card-img-placeholder">${typeEmoji}</div>`;

  const viralBadge = analysis.estimatedDailyRate >= 2
    ? `<span class="badge badge-viral">🔥 ${analysis.estimatedDailyRate} 則/天</span>`
    : analysis.estimatedDailyRate >= 0.5
    ? `<span class="badge badge-viral">📈 ${analysis.estimatedDailyRate} 則/天</span>`
    : '';

  const ratingBadge = analysis.recentAvgRating !== null
    ? `<span class="badge badge-warn">近期 ⭐ ${analysis.recentAvgRating}</span>`
    : '';

  const deltaBadge = analysis.ratingDelta !== null && Math.abs(analysis.ratingDelta) >= 0.3
    ? analysis.ratingDelta > 0
      ? `<span class="badge badge-ok">近期 +${analysis.ratingDelta}</span>`
      : `<span class="badge badge-warn">近期 ${analysis.ratingDelta}</span>`
    : '';

  const okBadge = '';

  const openTag = place.isOpen === true
    ? `<span class="card-open open">營業中</span>`
    : place.isOpen === false
    ? `<span class="card-open closed">已打烊</span>`
    : '';

  div.innerHTML = `
    <div class="card-top">
      ${imgEl}
      <div class="card-info">
        <div class="card-name">${place.name}</div>
        <div class="card-meta">
          <span class="card-rating">⭐ ${place.rating || 'N/A'}</span>
          <span class="card-count">${(place.totalRatings || 0).toLocaleString()} 則評論</span>
          ${openTag}
        </div>
        <div class="card-badges">
          ${viralBadge}${ratingBadge}${deltaBadge}
        </div>
      </div>
    </div>
    <div class="card-scores">
      <div class="score-item">
        <div class="score-label">
          <span>近期評論速度</span>
          <span style="color:var(--accent)">${analysis.estimatedDailyRate} 則/天</span>
        </div>
        <div class="score-bar"><div class="score-fill viral" style="width:${Math.min(analysis.estimatedDailyRate / 5 * 100, 100)}%"></div></div>
      </div>
      <div class="score-item">
        <div class="score-label">
          <span>近期平均星數</span>
          <span style="color:var(--warn)">${analysis.recentAvgRating ?? 'N/A'} ★</span>
        </div>
        <div class="score-bar"><div class="score-fill suspicious" style="width:${analysis.recentAvgRating ? analysis.recentAvgRating / 5 * 100 : 0}%"></div></div>
      </div>
    </div>
  `;

  return div;
}

// ── Sort ────────────────────────────────────────────────────────
function sortResults(by) {
  const sorted = [...allResults].sort((a, b) => {
    if (by === 'daily')        return (b.analysis.estimatedDailyRate || 0) - (a.analysis.estimatedDailyRate || 0);
    if (by === 'rating')       return (b.rating || 0) - (a.rating || 0);
    if (by === 'recentRating') return (b.analysis.recentAvgRating || 0) - (a.analysis.recentAvgRating || 0);
    return 0;
  });
  renderResults(sorted);
  clearMapMarkers();
  renderMapMarkers(sorted);
}

// ── Map Markers ─────────────────────────────────────────────────
const placeMarkers = [];

function clearMapMarkers() {
  placeMarkers.forEach(m => m.setMap(null));
  placeMarkers.length = 0;
}

function renderMapMarkers(data) {
  data.forEach((place, index) => {
    if (!place.lat || !place.lng) return;

    const isFirst = index === 0;
    const label = isFirst ? '👑' : '';

    const m = new google.maps.Marker({
      position: { lat: place.lat, lng: place.lng },
      map,
      title: place.name,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        fillColor: '#ff3b3b',
        fillOpacity: 0.9,
        strokeColor: '#fff',
        strokeWeight: 1.5,
        scale: 8,
      },
      label: isFirst ? {
        text: '👑',
        fontSize: '14px',
        color: '#fff',
      } : undefined,
      zIndex: isFirst ? 999 : 1
    });

    const rate = place.analysis.estimatedDailyRate || 0;
    const infoWindow = new google.maps.InfoWindow({
      content: `<div style="background:#111;color:#eee;padding:8px 10px;border-radius:3px;font-family:sans-serif;font-size:12px;min-width:140px">
        <div style="font-weight:700;margin-bottom:3px">${isFirst ? '👑 ' : ''}${place.name}</div>
        <div style="color:#aaa">⭐ ${place.rating || 'N/A'} · 📊 ${rate} 則/天</div>
      </div>`
    });

    m.addListener('click', () => {
      if (isMobile()) {
        closeMobileList();
        openMobileSheet(place);
      } else {
        openModal(place);
      }
    });
    m.addListener('mouseover', () => infoWindow.open(map, m));
    m.addListener('mouseout', () => infoWindow.close());

    placeMarkers.push(m);
  });
}

// ── Modal ───────────────────────────────────────────────────────
async function openModal(place) {
  const overlay = document.getElementById('modalOverlay');
  const content = document.getElementById('modalContent');
  overlay.classList.add('open');

  const { analysis } = place;
  const typeEmoji = getTypeEmoji(place.types);
  const heroImg = place.photoRef
    ? `<img src="/api/photo?ref=${place.photoRef}&maxwidth=600" alt="${place.name}">`
    : `<div class="modal-hero-placeholder">${typeEmoji}</div>`;

  const signalsHtml = analysis.signals.map(s =>
    `<div class="signal-item ${s.type}"><span>${s.icon}</span><span>${s.text}</span></div>`
  ).join('') || '<div class="signal-item genuine"><span>ℹ️</span><span>評論數據不足，無法分析</span></div>';

  const reviewsHtml = (analysis.recentReviews || []).map(r => {
    const date = r.time ? new Date(r.time * 1000).toLocaleDateString('zh-TW') : '';
    const suspicious = r.text && r.text.length < 20 && r.rating === 5;
    return `
      <div class="review-item">
        <div class="review-header">
          <span class="review-author">${r.author_name || '匿名'}</span>
          <span class="review-rating">${'⭐'.repeat(r.rating || 0)}</span>
        </div>
        <div class="review-time">${date}</div>
        <div class="review-text">${r.text || '（無文字評論）'}</div>
        
      </div>
    `;
  }).join('');

  content.innerHTML = `
    <div class="modal-hero">${heroImg}</div>
    <div class="modal-body">
      <div class="modal-name">${place.name}</div>
      <div class="modal-meta">
        <span class="modal-rating">⭐ ${place.rating || 'N/A'}</span>
        <span style="color:var(--text2);font-size:12px">${(place.totalRatings || 0).toLocaleString()} 則評論</span>
        ${place.priceLevel ? '<span style="color:var(--text2)">' + '💰'.repeat(place.priceLevel) + '</span>' : ''}
      </div>
      <div class="modal-address">📍 ${place.address || '地址不詳'}</div>

      <div class="analysis-section">
        <div class="analysis-title">聲量數據</div>
        <div class="score-row">
          <div class="score-block">
            <div class="score-num viral">${analysis.estimatedDailyRate}</div>
            <div class="score-sublabel">則/天（近期速度）</div>
          </div>
          <div class="score-block">
            <div class="score-num suspicious">${analysis.estimatedWeeklyVolume}</div>
            <div class="score-sublabel">則/週（估計）</div>
          </div>
          <div class="score-block">
            <div class="score-num" style="color:var(--neon2)">${analysis.spikeRatio}x</div>
            <div class="score-sublabel">速度倍數</div>
          </div>
        </div>
        <div class="score-row" style="margin-top:12px">
          <div class="score-block">
            <div class="score-num" style="color:var(--warn)">${analysis.recentAvgRating ?? 'N/A'}</div>
            <div class="score-sublabel">近期平均星數</div>
          </div>
          <div class="score-block">
            <div class="score-num" style="color:var(--text)">${analysis.ratingDelta !== null ? (analysis.ratingDelta > 0 ? '+' : '') + analysis.ratingDelta : 'N/A'}</div>
            <div class="score-sublabel">近期 vs 整體</div>
          </div>
          <div class="score-block">
            <div class="score-num" style="color:var(--neon2)">${analysis.photoAtMax ? '10+' : (analysis.photoCount ?? 0)}</div>
            <div class="score-sublabel">用戶上傳照片</div>
          </div>
        </div>
        <div style="margin-top:12px;padding:10px;background:var(--bg);border-radius:3px">
          <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:4px;text-align:center">
            ${[5,4,3,2,1].map(s => `
              <div>
                <div style="font-family:var(--font-mono);font-size:11px;color:var(--text3)">${s}★</div>
                <div style="font-size:16px;font-weight:700;color:var(--text)">${analysis.ratingDistribution?.[s] ?? 0}</div>
              </div>
            `).join('')}
          </div>
          <div style="font-family:var(--font-mono);font-size:10px;color:var(--text3);text-align:center;margin-top:6px">最新 5 則評論星數分佈</div>
        </div>
      </div>

      ${reviewsHtml ? `
        <div class="reviews-section">
          <div class="reviews-title">近期評論</div>
          ${reviewsHtml}
        </div>
      ` : ''}
    </div>
  `;
}

function closeModal(e) {
  if (!e || e.target === document.getElementById('modalOverlay') || e.type === 'click') {
    document.getElementById('modalOverlay').classList.remove('open');
  }
}

// ── Mobile Sheet Controls ───────────────────────────────────────
function toggleMobileList() {
  document.getElementById('mobileListSheet').classList.toggle('open');
  document.getElementById('mobileResultBadge').style.display = 'none';
}

function closeMobileList() {
  document.getElementById('mobileListSheet').classList.remove('open');
  document.getElementById('mobileResultBadge').style.display = 'flex';
}

function openMobileSheet(place) {
  const sheet = document.getElementById('mobileBottomSheet');
  const content = document.getElementById('mobileSheetContent');
  const card = createCard(place, 0);
  content.innerHTML = '';
  content.appendChild(card);
  // 點卡片打開 Modal
  card.onclick = () => openModal(place);
  sheet.classList.add('open');
}

function closeMobileSheet() {
  document.getElementById('mobileBottomSheet').classList.remove('open');
}

// ── Utils ───────────────────────────────────────────────────────
function getTypeEmoji(types = []) {
  if (types.includes('cafe')) return '☕';
  if (types.includes('bakery')) return '🥐';
  if (types.includes('meal_takeaway') || types.includes('meal_delivery')) return '🥡';
  if (types.includes('restaurant')) return '🍜';
  if (types.includes('bar') || types.includes('night_club')) return '🍺';
  return '🍽️';
}

function showLoading(show) {
  const el = document.getElementById('loadingOverlay');
  el.classList.toggle('active', show);
}

// ── Dark Map Style ──────────────────────────────────────────────
function darkMapStyle() {
  return [
    { elementType: 'geometry', stylers: [{ color: '#0a0a0a' }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: '#0a0a0a' }] },
    { elementType: 'labels.text.fill', stylers: [{ color: '#555' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#1a1a1a' }] },
    { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#222' }] },
    { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#252525' }] },
    { featureType: 'road.highway', elementType: 'labels.text.fill', stylers: [{ color: '#666' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#060d14' }] },
    { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#2a4060' }] },
    { featureType: 'poi', elementType: 'geometry', stylers: [{ color: '#0f0f0f' }] },
    { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#0a1a0a' }] },
    { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#111' }] },
    { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#1a1a1a' }] },
    { featureType: 'administrative.country', elementType: 'labels.text.fill', stylers: [{ color: '#888' }] },
    { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#999' }] },
  ];
}
