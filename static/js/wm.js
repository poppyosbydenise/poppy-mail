/* A tiny window manager: draggable, focusable, closable, minimizable windows on a desktop. */
window.WM = (function () {
  'use strict';
  var host = null, wins = {}, z = 20, cascade = 0;
  function init(el) { host = el; wins = {}; cascade = 0; }
  function focus(id) {
    var w = wins[id]; if (!w) return;
    z += 1; w.el.style.zIndex = z;
    Object.keys(wins).forEach(function (k) { wins[k].el.classList.toggle('active', k === id); });
  }
  function close(id) {
    var w = wins[id]; if (!w) return;
    if (w.onClose && w.onClose() === false) return;
    if (w.el.parentNode) w.el.parentNode.removeChild(w.el);
    delete wins[id];
  }
  function closeAll() { Object.keys(wins).forEach(function (k) { if (wins[k].el.parentNode) wins[k].el.parentNode.removeChild(wins[k].el); }); wins = {}; }
  function has(id) { return !!wins[id]; }
  function open(o) {
    if (!host) return null;
    if (wins[o.id]) { if (o.update) o.update(wins[o.id]); focus(o.id); return wins[o.id]; }
    var el = document.createElement('section');
    el.className = 'win ' + (o.cls || ''); el.setAttribute('role', 'group'); el.setAttribute('aria-label', o.title);
    var n = cascade++ % 6;
    el.style.left = (o.x != null ? o.x : 40 + n * 28) + 'px'; el.style.top = (o.y != null ? o.y : 30 + n * 28) + 'px';
    el.style.width = (o.w || 420) + 'px'; if (o.h) el.style.height = o.h + 'px';
    el.innerHTML = '<div class="win-title"><span class="win-ico" aria-hidden="true">' + (o.icon || '') + '</span><span class="win-text"></span><span class="win-btns">' +
      '<button type="button" class="wb wb-min" aria-label="Minimize window">_</button><button type="button" class="wb wb-close" aria-label="Close window">&#215;</button></span></div><div class="win-body"></div>';
    el.querySelector('.win-text').textContent = o.title;
    var handle = { id: o.id, el: el, body: el.querySelector('.win-body'), onClose: o.onClose, setTitle: function (t) { el.querySelector('.win-text').textContent = t; el.setAttribute('aria-label', t); } };
    wins[o.id] = handle; host.appendChild(el);
    el.addEventListener('pointerdown', function () { focus(o.id); });
    el.querySelector('.wb-close').addEventListener('click', function () { close(o.id); });
    el.querySelector('.wb-min').addEventListener('click', function () { el.classList.toggle('minimized'); });
    var tb = el.querySelector('.win-title'), drag = null;
    tb.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.wb') || e.button !== 0) return;
      var r = el.getBoundingClientRect(), hr = host.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, hr: hr }; try { tb.setPointerCapture(e.pointerId); } catch (x) {}
      e.preventDefault();
    });
    tb.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var x = e.clientX - drag.hr.left - drag.dx, y = e.clientY - drag.hr.top - drag.dy;
      x = Math.max(-el.offsetWidth + 80, Math.min(x, drag.hr.width - 80)); y = Math.max(0, Math.min(y, drag.hr.height - 30));
      el.style.left = x + 'px'; el.style.top = y + 'px';
    });
    function end(e) { drag = null; try { tb.releasePointerCapture(e.pointerId); } catch (x) {} }
    tb.addEventListener('pointerup', end); tb.addEventListener('pointercancel', end);
    tb.addEventListener('dblclick', function (e) { if (!e.target.closest('.wb')) el.classList.toggle('minimized'); });
    if (o.render) o.render(handle.body, handle);
    focus(o.id);
    return handle;
  }
  return { init: init, open: open, close: close, closeAll: closeAll, focus: focus, has: has, get: function (id) { return wins[id]; } };
})();
