(() => {
  'use strict';

  const COLORS = ['#4de0d3', '#a996ff', '#f0b86d', '#6aafff', '#f185b4', '#b4d879', '#ec8f75', '#88cddc'];
  const NS = 'http://www.w3.org/2000/svg';
  const $ = (id) => document.getElementById(id);
  const state = { hours: 6, data: null, hidden: new Set(), requestId: 0, controller: null, loading: false, nextRefresh: 0, serverOffset: 0, error: null, charts: [], timer: null };
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  const number = (value, digits = 0) => finite(value) ? value.toLocaleString(document.documentElement.lang, { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—';
  const now = () => Date.now() / 1000 + state.serverOffset;
  const localDate = (timestamp, options) => finite(timestamp) ? new Date(timestamp * 1000).toLocaleString(document.documentElement.lang, options) : '—';
  const clockTime = (timestamp) => localDate(timestamp, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const calendarDate = (timestamp) => localDate(timestamp, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const keyOf = (row) => String(row.gpu_uuid || `gpu-${row.gpu_index}`);
  const memoryPct = (row) => finite(row.memory_used_mib) && finite(row.memory_total_mib) && row.memory_total_mib > 0 ? row.memory_used_mib / row.memory_total_mib * 100 : null;
  const charts = [
    { id: 'power-chart', label: 'GPU power', unit: 'W', value: (row) => row.power_w, fixedMax: null },
    { id: 'util-chart', label: 'Utilization', unit: '%', value: (row) => row.gpu_util_pct, fixedMax: 100 },
    { id: 'memory-chart', label: 'Memory usage', unit: '%', value: memoryPct, fixedMax: 100 },
  ];

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function svgNode(tag, attributes = {}, text) {
    const element = document.createElementNS(NS, tag);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function getDevices() {
    const devices = new Map();
    for (const row of [...(state.data?.history || []), ...(state.data?.latest || [])]) devices.set(keyOf(row), row);
    return [...devices.entries()].sort((a, b) => a[1].gpu_index - b[1].gpu_index || a[0].localeCompare(b[0])).map(([key, row], index) => ({ key, row, color: COLORS[index % COLORS.length] }));
  }

  function setStatus(kind, text) {
    $('connection-status').dataset.state = kind;
    $('connection-text').textContent = text;
  }

  function updateStatus() {
    const data = state.data;
    const age = data && finite(data.latest_timestamp) ? Math.max(0, now() - data.latest_timestamp) : null;
    let notice = '';
    if (state.error) {
      setStatus('error', 'Disconnected');
      notice = `Refresh failed (${state.error}). ${data ? 'Showing the last available readings. Retrying shortly.' : 'Waiting for the server. Retrying shortly.'}`;
    } else if (data?.last_error) {
      setStatus('warning', 'Sampling error');
      notice = `Sampling failed (${data.last_error}). ${data.latest?.length ? 'Showing the last successful sample.' : 'Waiting for the next sample.'}`;
    } else if (age !== null && age > (data.interval_seconds || 300) * 1.5) {
      setStatus('warning', 'Data delayed');
      notice = `The last sample is ${Math.floor(age / 60)} minutes old. Check the sampler on the server.`;
    } else if (data && !data.latest?.length) {
      setStatus('warning', 'Awaiting sample');
      notice = 'Waiting for the first GPU sample. Readings and charts will appear automatically.';
    } else if (data) {
      setStatus('ok', 'Online');
    } else {
      setStatus('loading', 'Connecting');
    }
    $('notice').hidden = !notice;
    $('notice').textContent = notice;
  }

  function metric(label, value, unit) {
    const wrap = node('div');
    wrap.append(node('div', 'gpu-metric-label', label));
    const display = node('div', 'gpu-metric-value', value);
    display.append(node('span', 'unit', unit));
    wrap.append(display);
    return wrap;
  }

  function renderCards() {
    const data = state.data;
    const latest = data.latest || [];
    const devices = getDevices();
    const colorMap = new Map(devices.map((device) => [device.key, device.color]));
    $('hostname').textContent = data.hostname || 'GPU server';
    $('gpu-count').textContent = latest.length;
    $('gpu-model-summary').textContent = latest.length ? [...new Set(latest.map((row) => row.name))].join(' · ') : 'Waiting for first sample';
    $('gpu-model-summary').title = $('gpu-model-summary').textContent;
    const powers = latest.map((row) => row.power_w).filter(finite);
    $('total-power').textContent = powers.length === latest.length && latest.length ? number(powers.reduce((sum, value) => sum + value, 0)) : '—';
    const utils = latest.map((row) => row.gpu_util_pct).filter(finite);
    $('mean-util').textContent = utils.length === latest.length && latest.length ? number(utils.reduce((sum, value) => sum + value, 0) / utils.length) : '—';
    $('last-sample').textContent = clockTime(data.latest_timestamp);
    $('sample-date').textContent = finite(data.latest_timestamp) ? `${calendarDate(data.latest_timestamp)} · local time` : 'Sampled every 5 minutes';
    $('sample-count').textContent = `${number(data.sample_count || 0)} ${data.sample_count === 1 ? 'sample' : 'samples'}`;
    const fragment = document.createDocumentFragment();
    for (const row of latest) {
      const card = node('article', 'gpu-card');
      card.style.setProperty('--gpu-color', colorMap.get(keyOf(row)) || COLORS[0]);
      const title = node('div', 'gpu-card-title');
      title.append(node('h3', 'gpu-card-name', `GPU ${row.gpu_index}`));
      const model = node('span', 'gpu-card-model', row.name || 'Unknown model');
      model.title = row.name || 'Unknown model';
      title.append(model);
      const metrics = node('div', 'gpu-metrics');
      metrics.append(metric('Power', number(row.power_w, 1), 'W'), metric('Utilization', number(row.gpu_util_pct), '%'));
      const heading = node('div', 'gpu-memory-heading');
      heading.append(node('span', '', `Memory usage ${number(memoryPct(row), 1)}%`));
      heading.append(node('strong', '', `${number(finite(row.memory_used_mib) ? row.memory_used_mib / 1024 : null, 1)} / ${number(finite(row.memory_total_mib) ? row.memory_total_mib / 1024 : null, 1)} GiB`));
      const track = node('div', 'memory-track');
      const fill = node('div', 'memory-fill');
      fill.style.width = `${finite(memoryPct(row)) ? Math.min(100, Math.max(0, memoryPct(row))) : 0}%`;
      track.append(fill);
      const bottom = node('div', 'gpu-card-bottom');
      bottom.append(node('span', '', `Temperature ${number(row.temperature_c)} °C`), node('span', '', `Power limit ${number(row.power_limit_w)} W`));
      card.append(title, metrics, heading, track, bottom);
      fragment.append(card);
    }
    if (!latest.length) fragment.append(node('div', 'empty-card', 'Waiting for the first GPU sample.'));
    $('gpu-grid').replaceChildren(fragment);
  }

  function renderLegend() {
    const legend = $('legend');
    const fragment = document.createDocumentFragment();
    for (const device of getDevices()) {
      const button = node('button', 'legend-button');
      button.type = 'button';
      button.style.setProperty('--gpu-color', device.color);
      button.setAttribute('aria-pressed', String(!state.hidden.has(device.key)));
      button.title = `${device.row.name} · Show or hide in charts`;
      button.append(node('span', 'legend-dot'), node('span', '', `GPU ${device.row.gpu_index}`));
      button.addEventListener('click', () => {
        if (state.hidden.has(device.key)) state.hidden.delete(device.key);
        else state.hidden.add(device.key);
        button.setAttribute('aria-pressed', String(!state.hidden.has(device.key)));
        renderCharts();
      });
      fragment.append(button);
    }
    legend.replaceChildren(fragment);
  }

  function niceMax(value) {
    if (!(value > 0)) return 100;
    const raw = value * 1.1;
    const scale = 10 ** Math.floor(Math.log10(raw));
    const normalized = raw / scale;
    const step = normalized <= 2 ? 0.25 : normalized <= 5 ? 0.5 : 1;
    return Math.ceil(normalized / step) * step * scale;
  }

  function renderChart(config) {
    const container = $(config.id);
    const width = Math.max(container.clientWidth, 260);
    const height = container.clientHeight || 230;
    const pad = { left: 42, right: 16, top: 12, bottom: 34 };
    const plotWidth = width - pad.left - pad.right;
    const plotHeight = height - pad.top - pad.bottom;
    const end = finite(state.data?.server_time) ? state.data.server_time : now();
    const start = end - state.hours * 3600;
    const interval = state.data?.interval_seconds || 300;
    const devices = getDevices().filter((device) => !state.hidden.has(device.key));
    const history = (state.data?.history || []).filter((row) => row.timestamp >= start && row.timestamp <= end);
    const groups = devices.map((device) => ({ ...device, points: history.filter((row) => keyOf(row) === device.key) }));
    let maxValue = 0;
    let valuesCount = 0;
    for (const group of groups) for (const row of group.points) if (finite(config.value(row))) { maxValue = Math.max(maxValue, config.value(row)); valuesCount += 1; }
    const max = config.fixedMax || niceMax(maxValue);
    const x = (timestamp) => pad.left + (timestamp - start) / (end - start) * plotWidth;
    const y = (value) => pad.top + plotHeight - Math.min(max, Math.max(0, value)) / max * plotHeight;
    const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true' });
    const description = `${config.label} over the past ${state.hours} ${state.hours === 1 ? 'hour' : 'hours'} (${valuesCount} ${valuesCount === 1 ? 'reading' : 'readings'}).`;
    svg.append(svgNode('title', {}, description));
    for (let tick = 0; tick <= 4; tick += 1) {
      const value = max * tick / 4;
      const position = y(value);
      svg.append(svgNode('line', { class: 'chart-grid', x1: pad.left, x2: width - pad.right, y1: position, y2: position }));
      svg.append(svgNode('text', { class: 'chart-axis', x: pad.left - 9, y: position + 3, 'text-anchor': 'end' }, number(value, max < 10 && tick % 4 ? 1 : 0)));
    }
    const timeTicks = width < 450 ? 3 : width < 800 ? 4 : 6;
    for (let tick = 0; tick <= timeTicks; tick += 1) {
      const timestamp = start + (end - start) * tick / timeTicks;
      const label = state.hours >= 24 ? localDate(timestamp, { month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }) : localDate(timestamp, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      svg.append(svgNode('text', { class: 'chart-axis', x: x(timestamp), y: height - 9, 'text-anchor': tick === 0 ? 'start' : tick === timeTicks ? 'end' : 'middle' }, label));
    }
    for (const group of groups) {
      let segment = [];
      const draw = () => {
        if (!segment.length) return;
        const path = segment.map((row, index) => `${index ? 'L' : 'M'}${x(row.timestamp).toFixed(2)},${y(config.value(row)).toFixed(2)}`).join(' ');
        if (segment.length > 1) svg.append(svgNode('path', { class: 'chart-line', d: path, stroke: group.color }));
        if (segment.length === 1) svg.append(svgNode('circle', { cx: x(segment[0].timestamp), cy: y(config.value(segment[0])), r: 3.3, fill: group.color, stroke: '#101927', 'stroke-width': 1.5 }));
        segment = [];
      };
      for (const row of group.points) {
        if (!finite(config.value(row))) { draw(); continue; }
        if (segment.length && row.timestamp - segment[segment.length - 1].timestamp > interval * 1.5) draw();
        segment.push(row);
      }
      draw();
      const last = group.points[group.points.length - 1];
      if (last && finite(config.value(last))) svg.append(svgNode('circle', { cx: x(last.timestamp), cy: y(config.value(last)), r: 2.5, fill: group.color }));
    }
    const guide = svgNode('line', { class: 'chart-hover-line', x1: 0, x2: 0, y1: pad.top, y2: height - pad.bottom, visibility: 'hidden' });
    const markers = svgNode('g');
    svg.append(guide, markers);
    const tooltip = node('div', 'chart-tooltip');
    tooltip.hidden = true;
    tooltip.setAttribute('role', 'status');
    container.replaceChildren(svg, tooltip);
    container.setAttribute('aria-label', `${description} Use the left and right arrow keys to inspect samples.`);
    if (!valuesCount) {
      const message = devices.length ? 'No readings in this time range.' : getDevices().length ? 'Select a GPU above to show its readings.' : 'No samples yet';
      container.append(node('div', 'chart-empty chart-empty-over-grid', message));
    }
    const timestamps = [...new Set(groups.flatMap((group) => group.points.map((row) => row.timestamp)))].sort((a, b) => a - b);
    let selectedIndex = timestamps.length - 1;
    function hideTooltip() {
      tooltip.hidden = true;
      guide.setAttribute('visibility', 'hidden');
      markers.replaceChildren();
    }
    function showTooltip(index) {
      if (!timestamps.length) return;
      selectedIndex = Math.max(0, Math.min(index, timestamps.length - 1));
      const timestamp = timestamps[selectedIndex];
      const rows = groups.map((group) => ({ group, row: group.points.find((row) => row.timestamp === timestamp) })).filter((item) => item.row);
      const fragment = document.createDocumentFragment();
      fragment.append(node('div', 'tooltip-time', `${calendarDate(timestamp)} ${clockTime(timestamp)}`));
      markers.replaceChildren();
      for (const { group, row } of rows) {
        const value = config.value(row);
        const line = node('div', 'tooltip-row');
        const label = node('span', 'tooltip-label');
        const dot = node('span', 'legend-dot');
        dot.style.setProperty('--gpu-color', group.color);
        label.append(dot, node('span', '', `GPU ${row.gpu_index}`));
        line.append(label, node('span', 'tooltip-value', `${number(value, 1)} ${config.unit}`));
        fragment.append(line);
        if (finite(value)) markers.append(svgNode('circle', { cx: x(timestamp), cy: y(value), r: 4, fill: group.color, stroke: '#121a28', 'stroke-width': 2 }));
      }
      tooltip.replaceChildren(fragment);
      tooltip.hidden = false;
      guide.setAttribute('x1', x(timestamp));
      guide.setAttribute('x2', x(timestamp));
      guide.setAttribute('visibility', 'visible');
      const left = x(timestamp) + 14 + tooltip.offsetWidth <= width ? x(timestamp) + 14 : x(timestamp) - tooltip.offsetWidth - 14;
      tooltip.style.left = `${Math.max(0, Math.min(width - tooltip.offsetWidth, left))}px`;
      tooltip.style.top = '8px';
    }
    container.onpointermove = (event) => {
      if (!timestamps.length) return;
      const rect = container.getBoundingClientRect();
      const mouseX = (event.clientX - rect.left) / rect.width * width;
      if (mouseX < pad.left || mouseX > width - pad.right) { hideTooltip(); return; }
      const target = start + (mouseX - pad.left) / plotWidth * (end - start);
      let low = 0;
      let high = timestamps.length;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (timestamps[mid] < target) low = mid + 1;
        else high = mid;
      }
      const nearest = low === 0 ? 0 : low === timestamps.length ? low - 1 : target - timestamps[low - 1] < timestamps[low] - target ? low - 1 : low;
      showTooltip(nearest);
    };
    container.onpointerleave = hideTooltip;
    container.onblur = hideTooltip;
    container.onkeydown = (event) => {
      if (event.key === 'Escape') hideTooltip();
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        showTooltip(selectedIndex + (event.key === 'ArrowLeft' ? -1 : 1));
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        showTooltip(event.key === 'Home' ? 0 : timestamps.length - 1);
      }
    };
  }

  function renderCharts() { charts.forEach(renderChart); }

  function scheduleRefresh(success) {
    clearTimeout(state.timer);
    const interval = state.data?.interval_seconds || 300;
    const timestamp = now();
    const nextSample = state.data?.next_sample_at;
    let delay = success ? interval : 30;
    if (success && finite(nextSample)) {
      const untilSample = nextSample + 3 - timestamp;
      delay = untilSample > 0 ? Math.min(interval, untilSample) : 15;
    }
    delay = Math.max(3, delay);
    state.nextRefresh = timestamp + delay;
    state.timer = setTimeout(() => refresh(), delay * 1000);
    updateCountdown();
  }

  async function refresh() {
    const requestId = ++state.requestId;
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    state.loading = true;
    $('refresh-button').disabled = true;
    $('refresh-button').setAttribute('aria-busy', 'true');
    const timeout = setTimeout(() => controller.abort(), 20000);
    let success = false;
    try {
      const response = await fetch(`/api/data?hours=${state.hours}`, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!data || !Array.isArray(data.latest) || !Array.isArray(data.history)) throw new Error('Unexpected server response format');
      if (requestId !== state.requestId) return;
      state.data = data;
      if (finite(data.server_time)) state.serverOffset = data.server_time - Date.now() / 1000;
      state.error = null;
      renderCards();
      renderLegend();
      renderCharts();
      success = true;
    } catch (error) {
      if (requestId !== state.requestId) return;
      state.error = error.name === 'AbortError' ? 'Request timed out' : error.message || 'Network unavailable';
      if (!state.data) {
        $('gpu-grid').replaceChildren(node('div', 'empty-card', 'Cannot reach the server. Retrying automatically.'));
        charts.forEach((config) => $(config.id).replaceChildren(node('div', 'chart-empty', 'Cannot load history. Check the server connection.')));
      }
    } finally {
      clearTimeout(timeout);
      if (requestId === state.requestId) {
        state.loading = false;
        $('refresh-button').disabled = false;
        $('refresh-button').setAttribute('aria-busy', 'false');
        updateStatus();
        scheduleRefresh(success);
      }
    }
  }

  function updateCountdown() {
    if (state.loading) { $('countdown').textContent = 'Refreshing…'; return; }
    const seconds = Math.max(0, Math.ceil(state.nextRefresh - now()));
    $('countdown').textContent = state.nextRefresh ? `Next refresh in ${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : 'Syncing sample time…';
    updateStatus();
  }

  document.querySelectorAll('[data-hours]').forEach((button) => {
    button.addEventListener('click', () => {
      const hours = Number(button.dataset.hours);
      if (hours === state.hours) return;
      state.hours = hours;
      document.querySelectorAll('[data-hours]').forEach((item) => item.setAttribute('aria-pressed', String(Number(item.dataset.hours) === hours)));
      clearTimeout(state.timer);
      refresh();
    });
  });
  $('refresh-button').addEventListener('click', () => { clearTimeout(state.timer); refresh(); });
  window.addEventListener('focus', () => { if (!state.loading && now() >= state.nextRefresh) refresh(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !state.loading && now() >= state.nextRefresh) refresh(); });
  let resizeTimer;
  const resize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.data) renderCharts(); }, 100); };
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(resize);
    charts.forEach((config) => observer.observe($(config.id)));
  } else window.addEventListener('resize', resize);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  $('timezone-label').textContent = `Local time${zone ? ' · ' + zone : ''}`;
  setInterval(updateCountdown, 1000);
  refresh();
})();
