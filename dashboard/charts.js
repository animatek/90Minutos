// Gráficas en SVG puro. Sin librerías: son dos formas y así el panel funciona
// sin red y sin nada que actualizar.
//
// Reglas que se respetan aquí a propósito:
//  · el color sigue al tema (entidad), nunca a su posición en el ranking, así que
//    filtrar no repinta lo que queda;
//  · más de ocho temas se agrupan en "Otros" en vez de inventar tonos nuevos;
//  · los valores van escritos, no solo codificados en color;
//  · el texto usa colores de texto, nunca el color de la serie.
(function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const MAX_SLOTS = 8;
  const RADIUS = 4;      // extremo redondeado del dato
  const GAP = 2;         // separación entre marcas contiguas

  function el(name, attrs = {}) {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== null && v !== undefined) node.setAttribute(k, String(v));
    }
    return node;
  }

  function text(content, attrs = {}) {
    const node = el('text', attrs);
    node.textContent = content;      // textContent: los nombres de tema son datos
    return node;
  }

  /** Color de una entidad: slot validado (se adapta a claro/oscuro) o hex propio. */
  function entityColor(slot, fallbackHex) {
    if (slot && slot >= 1 && slot <= MAX_SLOTS) return `var(--series-${slot})`;
    return fallbackHex || 'var(--series-other)';
  }

  /** Barra horizontal: extremo derecho redondeado, izquierdo anclado a la base. */
  function barPathH(x0, x1, y, h, r = RADIUS) {
    const w = x1 - x0;
    if (w <= r) return `M${x0},${y} h${Math.max(w, 0.5)} v${h} h${-Math.max(w, 0.5)} Z`;
    return `M${x0},${y} H${x1 - r} A${r},${r} 0 0 1 ${x1},${y + r} V${y + h - r} A${r},${r} 0 0 1 ${x1 - r},${y + h} H${x0} Z`;
  }

  /** Barra vertical: extremo superior redondeado, base anclada al eje. */
  function barPathV(x, w, yTop, yBase, r = RADIUS) {
    const h = yBase - yTop;
    if (h <= r) return `M${x},${yBase} v${-Math.max(h, 0.5)} h${w} v${Math.max(h, 0.5)} Z`;
    return `M${x},${yBase} V${yTop + r} A${r},${r} 0 0 1 ${x + r},${yTop} H${x + w - r} A${r},${r} 0 0 1 ${x + w},${yTop + r} V${yBase} Z`;
  }

  // --- Tooltip compartido ----------------------------------------------------

  const tip = document.getElementById('chartTip');

  function showTip(html, ev) {
    if (!tip) return;
    tip.innerHTML = html;
    tip.hidden = false;
    const pad = 12;
    const rect = tip.getBoundingClientRect();
    let x = ev.clientX + pad;
    let y = ev.clientY + pad;
    if (x + rect.width > window.innerWidth - pad) x = ev.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight - pad) y = ev.clientY - rect.height - pad;
    tip.style.left = `${Math.max(pad, x)}px`;
    tip.style.top = `${Math.max(pad, y)}px`;
  }

  function hideTip() { if (tip) tip.hidden = true; }

  // El tooltip es HTML, así que todo lo que venga de datos se escapa.
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  /** Añade el comportamiento de hover a una marca, con área de impacto ampliada. */
  function hoverable(node, html) {
    node.addEventListener('mousemove', (ev) => showTip(html, ev));
    node.addEventListener('mouseleave', hideTip);
    node.style.cursor = 'default';
  }

  // Compacto a propósito: en la etiqueta al final de la barra el espacio es fijo
  // y "58 h 21 min" se cortaba a "58 h 21 mi".
  function fmtHours(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    if (h && m) return `${h}h ${m}m`;
    if (h) return `${h}h`;
    return `${m}m`;
  }

  /** Paso de eje "redondo" y su etiqueta, para que no salgan marcas repetidas. */
  const STEPS = [300, 600, 900, 1800, 3600, 7200, 10800, 14400, 21600, 28800, 43200, 86400];

  function axisSteps(maxSec, target = 3) {
    const ideal = maxSec / target;
    const step = STEPS.find(s => s >= ideal) || STEPS[STEPS.length - 1];
    const top = Math.ceil(maxSec / step) * step;
    const ticks = [];
    for (let v = 0; v <= top + 1; v += step) ticks.push(v);
    return { top, ticks };
  }

  function fmtTick(sec) {
    if (sec === 0) return '0';
    if (sec % 3600 === 0) return `${sec / 3600}h`;
    return `${Math.round(sec / 60)}m`;
  }

  function emptyState(container, message) {
    container.replaceChildren();
    const p = document.createElement('p');
    p.className = 'chart-empty';
    p.textContent = message;
    container.appendChild(p);
  }

  // --- Horas por tema: barras horizontales ordenadas -------------------------
  // Barras ordenadas por magnitud, con el nombre en el eje y el valor escrito al
  // final. Una sola serie: la identidad la da la etiqueta, no hace falta leyenda.

  function renderTopicBars(container, rows) {
    if (!container) return;
    if (!rows || !rows.length) return emptyState(container, 'Todavía no hay sesiones en este rango.');

    // Más de ocho temas: los pequeños se agrupan en "Otros".
    let data = rows.slice(0, MAX_SLOTS).map(r => ({
      label: r.topic, sec: r.totalSec, sessions: r.sessions,
      color: entityColor(r.slot, r.color),
    }));
    const rest = rows.slice(MAX_SLOTS);
    if (rest.length) {
      data.push({
        label: `Otros (${rest.length})`,
        sec: rest.reduce((a, r) => a + r.totalSec, 0),
        sessions: rest.reduce((a, r) => a + r.sessions, 0),
        color: 'var(--series-other)',
        isOther: true,
        detail: rest,
      });
    }

    const width = Math.max(320, container.clientWidth || 560);
    const rowH = 30;
    const labelW = Math.min(170, Math.max(96, Math.round(width * 0.3)));
    const valueW = 84;
    const top = 6;
    const height = top + data.length * rowH + 6;
    const plotX0 = labelW + 10;
    const plotX1 = width - valueW;
    const max = Math.max(...data.map(d => d.sec)) || 1;

    const svg = el('svg', {
      width, height, viewBox: `0 0 ${width} ${height}`,
      role: 'img', 'aria-label': 'Horas acumuladas por tema',
    });

    data.forEach((d, i) => {
      const y = top + i * rowH;
      const barH = rowH - GAP * 2;
      const barY = y + GAP;
      const x1 = plotX0 + (d.sec / max) * (plotX1 - plotX0);

      // Carril de fondo: da referencia de escala sin dibujar una rejilla.
      svg.appendChild(el('path', {
        d: barPathH(plotX0, plotX1, barY, barH),
        fill: 'var(--chart-track)',
      }));

      const bar = el('path', { d: barPathH(plotX0, x1, barY, barH), fill: d.color });
      const detail = d.isOther
        ? d.detail.slice(0, 5).map(r => `${esc(r.topic)} · ${fmtHours(r.totalSec)}`).join('<br>')
        : '';
      hoverable(bar, `<strong>${esc(d.label)}</strong><br>${fmtHours(d.sec)} · ${d.sessions} sesion${d.sessions === 1 ? '' : 'es'}${detail ? '<hr>' + detail : ''}`);
      svg.appendChild(bar);

      // Nombre del tema (color de texto, no de serie) y valor escrito.
      const name = text(d.label, {
        x: labelW, y: barY + barH / 2, 'text-anchor': 'end',
        'dominant-baseline': 'central', class: 'chart-label',
      });
      name.appendChild(el('title')).textContent = d.label;
      svg.appendChild(name);

      svg.appendChild(text(fmtHours(d.sec), {
        x: plotX1 + 8, y: barY + barH / 2,
        'dominant-baseline': 'central', class: 'chart-value',
      }));
    });

    container.replaceChildren(svg);
  }

  // --- Últimos días: barras verticales --------------------------------------

  function renderDayBars(container, days) {
    if (!container) return;
    if (!days || !days.length) return emptyState(container, 'Sin actividad reciente.');

    const width = Math.max(320, container.clientWidth || 560);
    const height = 200;
    const padTop = 16, padBottom = 28, padLeft = 34, padRight = 8;
    const plotH = height - padTop - padBottom;
    const plotW = width - padLeft - padRight;
    const yBase = padTop + plotH;

    // Escala con pasos redondos: así el eje nunca repite la misma etiqueta.
    const { top: max, ticks } = axisSteps(Math.max(...days.map(d => d.sec), 1800));

    const svg = el('svg', {
      width, height, viewBox: `0 0 ${width} ${height}`,
      role: 'img', 'aria-label': 'Horas por día en los últimos 14 días',
    });

    for (const value of ticks) {
      const y = yBase - (value / max) * plotH;
      svg.appendChild(el('line', {
        x1: padLeft, x2: width - padRight, y1: y, y2: y,
        class: value === 0 ? 'chart-axis' : 'chart-grid',
      }));
      svg.appendChild(text(fmtTick(value), {
        x: padLeft - 6, y, 'text-anchor': 'end',
        'dominant-baseline': 'central', class: 'chart-tick',
      }));
    }

    const band = plotW / days.length;
    const barW = Math.max(3, band - GAP * 2);

    days.forEach((d, i) => {
      const x = padLeft + i * band + (band - barW) / 2;
      const h = (d.sec / max) * plotH;
      const yTop = yBase - h;

      if (d.sec > 0) {
        const bar = el('path', {
          d: barPathV(x, barW, yTop, yBase),
          fill: d.isToday ? 'var(--series-1)' : 'var(--chart-bar)',
        });
        hoverable(bar, `<strong>${esc(d.labelLong)}</strong><br>${fmtHours(d.sec)} · ${d.sessions} sesion${d.sessions === 1 ? '' : 'es'}`);
        svg.appendChild(bar);
      } else {
        // Un día sin actividad se marca en la base: ausencia visible, no hueco.
        svg.appendChild(el('line', {
          x1: x, x2: x + barW, y1: yBase, y2: yBase, class: 'chart-zero',
        }));
      }

      // Etiquetas alternas para que no se solapen.
      if (i % 2 === days.length % 2) {
        svg.appendChild(text(d.labelShort, {
          x: x + barW / 2, y: yBase + 14, 'text-anchor': 'middle', class: 'chart-tick',
        }));
      }
    });

    container.replaceChildren(svg);
  }

  // Redibujar al cambiar el tamaño: el SVG se genera en píxeles reales para que
  // el texto no se escale de forma rara.
  const redrawers = new Map();
  function registerRedraw(container, fn) {
    if (!container) return;
    redrawers.set(container, fn);
  }
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { for (const fn of redrawers.values()) fn(); }, 150);
  });

  window.Charts = { renderTopicBars, renderDayBars, registerRedraw, fmtHours };
})();
