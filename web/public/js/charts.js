/**
 * STOXVAULT — charts.
 *
 * Everything except the candle chart is hand-drawn inline SVG: a donut for the
 * basket split, a sparkline for the 7-day column, and the demand bars are plain
 * DOM. No chart library, no canvas, no gradients.
 *
 * Colour never appears in this file as a hex value. Shapes either inherit
 * `currentColor` (so the CSS decides) or read a CSS custom property at draw
 * time, which is also how the candle chart is themed and re-themed.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/* ------------------------------------------------------------------ theme -- */

/**
 * Read a CSS custom property, resolving one level of `var(--other)` by hand.
 * Browsers substitute variables in computed custom properties, but a token file
 * that aliases (`--chart-axis: var(--ink-3)`) is common enough to be worth the
 * belt and braces.
 */
export function cssVar(name, fallback = '') {
  if (typeof window === 'undefined') return fallback;
  const root = document.documentElement;
  let value = getComputedStyle(root).getPropertyValue(name).trim();
  for (let depth = 0; depth < 4 && /^var\(\s*--/.test(value); depth++) {
    const inner = value.slice(value.indexOf('(') + 1, value.lastIndexOf(')')).split(',')[0].trim();
    value = getComputedStyle(root).getPropertyValue(inner).trim();
  }
  return value || fallback;
}

/** The palette the candle chart is built from, re-read on every theme change. */
export function chartPalette() {
  return {
    grid: cssVar('--chart-grid', 'rgba(0,0,0,0.07)'),
    axis: cssVar('--chart-axis', '#667080'),
    line: cssVar('--chart-line', '#0B0D10'),
    up: cssVar('--chart-up', '#0E9F6E'),
    down: cssVar('--chart-down', '#D83A3A'),
    surface: cssVar('--surface', '#FFFFFF'),
    ink: cssVar('--ink', '#0B0D10'),
    rule: cssVar('--rule', 'rgba(0,0,0,0.1)'),
  };
}

function el(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    node.setAttribute(key, String(value));
  }
  return node;
}

/* ------------------------------------------------------------------ donut -- */

export const DONUT_RADIUS = 46;
export const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS; // 289.026…

/**
 * Arcs for `#donut-arcs`, which the shell has already rotated -90deg so the
 * first slice starts at twelve o'clock.
 *
 * @param {{pct: number, mint?: string, symbol?: string}[]} slices
 * @returns {DocumentFragment} `<circle class="donut__arc" data-slice="0..4">`
 */
export function buildDonutArcs(slices) {
  const frag = document.createDocumentFragment();
  let offset = 0;
  const rows = Array.isArray(slices) ? slices : [];

  rows.forEach((slice, index) => {
    const pct = Math.max(0, Number(slice?.pct) || 0);
    if (pct <= 0) return;
    const length = (DONUT_CIRCUMFERENCE * pct) / 100;
    const arc = el('circle', {
      class: 'donut__arc',
      cx: '60',
      cy: '60',
      r: String(DONUT_RADIUS),
      'stroke-dasharray': `${length.toFixed(3)} ${DONUT_CIRCUMFERENCE.toFixed(3)}`,
      'stroke-dashoffset': `${(-DONUT_CIRCUMFERENCE * offset) / 100}`,
    });
    arc.dataset.slice = String(index % 5);
    if (slice?.mint) arc.dataset.mint = slice.mint;
    if (slice?.symbol) {
      const title = el('title');
      title.textContent = `${slice.symbol} ${pct}%`;
      arc.appendChild(title);
    }
    frag.appendChild(arc);
    offset += pct;
  });

  return frag;
}

/* -------------------------------------------------------------- sparkline -- */

/**
 * A 7-day sparkline from closing prices. Returns null when there is nothing
 * honest to draw, so the caller can leave the shipped "no data" hairline alone.
 *
 * @param {number[]} closes oldest first
 * @param {{width?: number, height?: number, pad?: number}} [opts]
 * @returns {SVGSVGElement|null}
 */
export function buildSparkline(closes, { width = 84, height = 24, pad = 2 } = {}) {
  const series = (Array.isArray(closes) ? closes : []).map(Number).filter((n) => Number.isFinite(n));
  if (series.length < 2) return null;

  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min;
  const innerH = height - pad * 2;
  const stepX = series.length > 1 ? width / (series.length - 1) : width;

  const points = series.map((value, index) => {
    const x = index * stepX;
    // A flat series sits on the centre line instead of collapsing to the top.
    const ratio = span === 0 ? 0.5 : (value - min) / span;
    const y = pad + (1 - ratio) * innerH;
    return [x, y];
  });

  const d = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');

  const svg = el('svg', {
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'none',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  svg.appendChild(el('path', { class: 'spark__line', d }));
  return svg;
}

/** up / down / flat for a series, from first close to last. */
export function seriesDirection(closes) {
  const series = (Array.isArray(closes) ? closes : []).map(Number).filter((n) => Number.isFinite(n));
  if (series.length < 2) return 'flat';
  const delta = series[series.length - 1] - series[0];
  if (delta > 0) return 'up';
  if (delta < 0) return 'down';
  return 'flat';
}

/* ------------------------------------------------------ SVG line fallback -- */

/**
 * The chart we draw ourselves when `lightweight-charts` did not load — a CDN
 * can be blocked, and a blocked CDN should cost you candles, not the panel.
 * Colours come from `currentColor`, so it themes itself.
 */
function buildLineChart(candles, { width = 640, height = 300 } = {}) {
  const rows = candles.filter((c) => Number.isFinite(c.c));
  if (rows.length < 2) return null;

  const padL = 8;
  const padR = 56;
  const padT = 12;
  const padB = 22;
  const innerW = Math.max(1, width - padL - padR);
  const innerH = Math.max(1, height - padT - padB);

  const values = rows.map((c) => c.c);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || Math.abs(hi) || 1;

  const x = (i) => padL + (i / (rows.length - 1)) * innerW;
  const y = (v) => padT + (1 - (v - lo) / span) * innerH;

  const svg = el('svg', {
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'none',
    class: 'fallback-chart',
    role: 'img',
    'aria-label': 'Price history line chart',
  });
  svg.style.width = '100%';
  svg.style.height = '100%';

  // Four horizontal guides with a price label each.
  const guides = el('g', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1', opacity: '0.12' });
  const labels = el('g', { fill: 'currentColor', opacity: '0.55', 'font-size': '10' });
  for (let i = 0; i <= 3; i++) {
    const value = lo + (span * i) / 3;
    const gy = y(value);
    guides.appendChild(el('line', { x1: padL, y1: gy.toFixed(2), x2: padL + innerW, y2: gy.toFixed(2) }));
    const label = el('text', { x: padL + innerW + 6, y: (gy + 3.5).toFixed(2) });
    label.textContent = value >= 1000 ? value.toFixed(0) : value.toFixed(2);
    label.style.fontFamily = 'var(--font-mono)';
    labels.appendChild(label);
  }
  svg.appendChild(guides);

  const d = rows.map((c, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)} ${y(c.c).toFixed(2)}`).join(' ');
  const area = `${d} L${x(rows.length - 1).toFixed(2)} ${padT + innerH} L${padL} ${padT + innerH} Z`;

  svg.appendChild(el('path', { d: area, fill: 'currentColor', opacity: '0.06', stroke: 'none' }));
  svg.appendChild(
    el('path', {
      d,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.5',
      'stroke-linejoin': 'round',
      'vector-effect': 'non-scaling-stroke',
    }),
  );
  svg.appendChild(labels);
  return svg;
}

/* ----------------------------------------------------------- candle chart -- */

/** The library is loaded with `defer` from the shell; it may simply not be there. */
function lib() {
  return typeof window !== 'undefined' && window.LightweightCharts ? window.LightweightCharts : null;
}

/**
 * The drawer's price chart.
 *
 * `setData(candles, kind)` takes the `/api/universe/:symbol/history` payload:
 * `kind === 'candles'` draws candlesticks, `kind === 'line'` (the CoinGecko
 * fallback, which is close-only) draws a line — the shape of the data decides,
 * never the renderer, so a close-only series is never dressed up as OHLC.
 *
 * @param {HTMLElement} mount `#chart-mount`
 */
export function createPriceChart(mount) {
  let chart = null;
  let series = null;
  let mode = null; // 'candles' | 'line'
  let last = null; // { candles, kind } so a theme change can redraw
  let resizeObserver = null;
  let fallback = null;

  function size() {
    const rect = mount.getBoundingClientRect();
    return {
      width: Math.max(160, Math.round(rect.width) || mount.clientWidth || 640),
      height: Math.max(120, Math.round(rect.height) || mount.clientHeight || 300),
    };
  }

  function optionsFor(palette, dims) {
    return {
      width: dims.width,
      height: dims.height,
      layout: {
        background: { color: 'transparent' },
        textColor: palette.axis,
        fontFamily: cssVar('--font-mono', 'monospace'),
        fontSize: 11,
      },
      grid: {
        vertLines: { color: palette.grid },
        horzLines: { color: palette.grid },
      },
      rightPriceScale: { borderColor: palette.grid },
      timeScale: { borderColor: palette.grid, timeVisible: false, secondsVisible: false },
      crosshair: {
        vertLine: { color: palette.axis, width: 1, style: 3, labelBackgroundColor: palette.ink },
        horzLine: { color: palette.axis, width: 1, style: 3, labelBackgroundColor: palette.ink },
      },
      handleScale: { axisPressedMouseMove: false },
      localization: { dateFormat: 'yyyy-MM-dd' },
    };
  }

  function destroyChart() {
    if (chart) {
      try {
        chart.remove();
      } catch (err) {
        /* already gone */
      }
    }
    chart = null;
    series = null;
    mode = null;
  }

  function clearFallback() {
    if (fallback && fallback.parentNode) fallback.parentNode.removeChild(fallback);
    fallback = null;
  }

  function drawFallback(candles) {
    clearFallback();
    const dims = size();
    fallback = buildLineChart(candles, dims);
    if (fallback) mount.appendChild(fallback);
    return Boolean(fallback);
  }

  /**
   * @param {{t: number, o: number, h: number, l: number, c: number}[]} candles
   * @param {'candles'|'line'} kind
   * @returns {boolean} false when there was nothing to draw
   */
  function setData(candles, kind = 'candles') {
    const rows = (Array.isArray(candles) ? candles : [])
      .map((c) => ({
        time: Math.floor(Number(c.t)),
        open: Number(c.o),
        high: Number(c.h),
        low: Number(c.l),
        close: Number(c.c),
      }))
      .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close))
      .sort((a, b) => a.time - b.time)
      // lightweight-charts rejects duplicate timestamps outright
      .filter((c, i, arr) => i === 0 || c.time !== arr[i - 1].time);

    if (rows.length === 0) {
      last = null;
      destroyChart();
      clearFallback();
      return false;
    }

    last = { candles, kind };
    const LWC = lib();
    if (!LWC || typeof LWC.createChart !== 'function') {
      destroyChart();
      return drawFallback(rows.map((r) => ({ t: r.time, c: r.close })));
    }

    clearFallback();
    const palette = chartPalette();
    const dims = size();
    const wantMode = kind === 'line' ? 'line' : 'candles';

    if (!chart) {
      chart = LWC.createChart(mount, optionsFor(palette, dims));
    } else {
      chart.applyOptions(optionsFor(palette, dims));
    }

    if (mode !== wantMode) {
      if (series) {
        try {
          chart.removeSeries(series);
        } catch (err) {
          /* the chart was recreated under us */
        }
      }
      series = null;
      mode = wantMode;
    }

    if (!series) {
      series =
        wantMode === 'line'
          ? chart.addLineSeries({ color: palette.line, lineWidth: 2, priceLineVisible: false })
          : chart.addCandlestickSeries({
              upColor: palette.up,
              downColor: palette.down,
              borderUpColor: palette.up,
              borderDownColor: palette.down,
              wickUpColor: palette.up,
              wickDownColor: palette.down,
            });
    } else {
      series.applyOptions(
        wantMode === 'line'
          ? { color: palette.line }
          : {
              upColor: palette.up,
              downColor: palette.down,
              borderUpColor: palette.up,
              borderDownColor: palette.down,
              wickUpColor: palette.up,
              wickDownColor: palette.down,
            },
      );
    }

    if (wantMode === 'line') {
      series.setData(rows.map((r) => ({ time: r.time, value: r.close })));
    } else {
      series.setData(
        rows.map((r) => ({
          time: r.time,
          open: Number.isFinite(r.open) ? r.open : r.close,
          high: Number.isFinite(r.high) ? r.high : r.close,
          low: Number.isFinite(r.low) ? r.low : r.close,
          close: r.close,
        })),
      );
    }

    chart.timeScale().fitContent();
    observe();
    return true;
  }

  function resize() {
    const dims = size();
    if (chart) chart.applyOptions({ width: dims.width, height: dims.height });
  }

  function observe() {
    if (resizeObserver || typeof ResizeObserver === 'undefined') return;
    resizeObserver = new ResizeObserver(() => resize());
    resizeObserver.observe(mount);
  }

  /** Re-read the palette and redraw. Called when the theme flips. */
  function applyTheme() {
    if (!last) return;
    const { candles, kind } = last;
    destroyChart();
    setData(candles, kind);
  }

  function destroy() {
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    destroyChart();
    clearFallback();
    last = null;
  }

  return {
    setData,
    resize,
    applyTheme,
    destroy,
    get usingLibrary() {
      return Boolean(chart);
    },
    get hasData() {
      return Boolean(last);
    },
  };
}

export default { cssVar, chartPalette, buildDonutArcs, buildSparkline, seriesDirection, createPriceChart };
