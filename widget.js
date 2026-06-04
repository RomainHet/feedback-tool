(function () {
  'use strict';

  var script =
    document.currentScript ||
    Array.prototype.slice.call(document.scripts).find(function (s) {
      return s.src && /widget\.js(\?.*)?$/.test(s.src);
    });
  if (!script) return;

  var projectId = script.getAttribute('data-project-id');
  if (!projectId) {
    console.warn('[feedback-widget] missing data-project-id on script tag');
    return;
  }

  var apiBase;
  try {
    apiBase = new URL(script.src).origin;
  } catch (e) {
    apiBase = '';
  }

  var STATE = {
    active: false,
    pins: [],
    pending: null,
    openBubble: null,
  };

  injectStyles();

  var root = document.createElement('div');
  root.id = '__fw_root';
  // No pointer-events on the root so the page stays interactive; children
  // re-enable pointer events individually.
  document.documentElement.appendChild(root);

  var toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = '__fw_toggle';
  toggle.textContent = 'Comment';
  toggle.addEventListener('click', function (e) {
    e.stopPropagation();
    setActive(!STATE.active);
  });
  root.appendChild(toggle);

  // Capture-phase click handler so we get the click before page handlers,
  // but only when comment mode is on and the click isn't on widget UI.
  document.addEventListener(
    'click',
    function (e) {
      if (!STATE.active) return;
      if (e.target.closest('#__fw_root')) return;
      if (STATE.pending) return;
      e.preventDefault();
      e.stopPropagation();
      var xPct = (e.clientX / window.innerWidth) * 100;
      var yPct = (e.clientY / window.innerHeight) * 100;
      openComposer(xPct, yPct);
    },
    true
  );

  // Close open bubble when clicking elsewhere.
  document.addEventListener('click', function (e) {
    if (!STATE.openBubble) return;
    if (e.target.closest('.__fw_placed')) return;
    if (e.target.closest('#__fw_root .__fw_toggle')) return;
    closeOpenBubble();
  });

  // Re-render on route changes.
  var origPush = history.pushState;
  history.pushState = function () {
    var r = origPush.apply(this, arguments);
    load();
    return r;
  };
  window.addEventListener('popstate', load);
  window.addEventListener('resize', renderPins);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }

  function setActive(on) {
    STATE.active = !!on;
    toggle.classList.toggle('__fw_toggle_on', STATE.active);
    document.documentElement.classList.toggle('__fw_commenting', STATE.active);
    if (!STATE.active && STATE.pending) {
      STATE.pending.el.remove();
      STATE.pending = null;
    }
  }

  function openComposer(xPct, yPct) {
    closeOpenBubble();
    var wrap = document.createElement('div');
    wrap.className = '__fw_placed __fw_pending';
    wrap.style.left = xPct + '%';
    wrap.style.top = yPct + '%';
    wrap.innerHTML =
      '<div class="__fw_pin __fw_pin_new">+</div>' +
      '<form class="__fw_popover">' +
      '<input class="__fw_name" placeholder="Your name" maxlength="120" />' +
      '<textarea class="__fw_text" placeholder="Leave a comment" rows="3" maxlength="4000"></textarea>' +
      '<div class="__fw_actions">' +
      '<button type="button" class="__fw_cancel">Cancel</button>' +
      '<button type="submit" class="__fw_submit">Send</button>' +
      '</div>' +
      '</form>';
    root.appendChild(wrap);
    STATE.pending = { el: wrap, x: xPct, y: yPct };
    var nameInput = wrap.querySelector('.__fw_name');
    var textInput = wrap.querySelector('.__fw_text');
    setTimeout(function () { nameInput.focus(); }, 0);

    wrap.querySelector('.__fw_cancel').addEventListener('click', function () {
      wrap.remove();
      STATE.pending = null;
    });

    wrap.querySelector('.__fw_popover').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var author = nameInput.value.trim();
      var text = textInput.value.trim();
      if (!text) {
        textInput.focus();
        return;
      }
      var submitBtn = wrap.querySelector('.__fw_submit');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';
      fetch(apiBase + '/api/comments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          pathname: location.pathname,
          x_pct: xPct,
          y_pct: yPct,
          text: text,
          author: author || null,
        }),
      })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (!res.ok) throw new Error(res.j && res.j.error || 'request failed');
          STATE.pins.push(res.j);
          wrap.remove();
          STATE.pending = null;
          renderPins();
        })
        .catch(function (err) {
          console.error('[feedback-widget]', err);
          submitBtn.disabled = false;
          submitBtn.textContent = 'Send';
        });
    });
  }

  function load() {
    closeOpenBubble();
    if (STATE.pending) {
      STATE.pending.el.remove();
      STATE.pending = null;
    }
    var u = apiBase + '/api/comments?project_id=' + encodeURIComponent(projectId) +
            '&path=' + encodeURIComponent(location.pathname);
    fetch(u)
      .then(function (r) { return r.json(); })
      .then(function (rows) {
        STATE.pins = Array.isArray(rows) ? rows : [];
        renderPins();
      })
      .catch(function (err) {
        console.error('[feedback-widget]', err);
      });
  }

  function renderPins() {
    // Remove existing rendered pin wrappers (but not the pending composer).
    Array.prototype.slice.call(root.querySelectorAll('.__fw_placed:not(.__fw_pending)'))
      .forEach(function (n) { n.remove(); });

    STATE.pins.forEach(function (c, i) {
      var wrap = document.createElement('div');
      wrap.className = '__fw_placed';
      wrap.style.left = Number(c.x_pct) + '%';
      wrap.style.top = Number(c.y_pct) + '%';
      wrap.dataset.id = c.id;

      var pin = document.createElement('button');
      pin.type = 'button';
      pin.className = '__fw_pin __fw_pin_saved';
      pin.textContent = String(i + 1);
      pin.addEventListener('click', function (e) {
        e.stopPropagation();
        if (wrap.querySelector('.__fw_bubble')) {
          closeOpenBubble();
          return;
        }
        closeOpenBubble();
        var bubble = document.createElement('div');
        bubble.className = '__fw_bubble';
        var when = '';
        try { when = new Date(c.created_at).toLocaleString(); } catch (_) {}
        bubble.innerHTML =
          '<div class="__fw_author">' + escapeHtml(c.author || 'Anonymous') + '</div>' +
          '<div class="__fw_text_view">' + escapeHtml(c.text) + '</div>' +
          '<div class="__fw_meta">' + escapeHtml(when) + '</div>';
        wrap.appendChild(bubble);
        STATE.openBubble = wrap;
      });
      wrap.appendChild(pin);
      root.appendChild(wrap);
    });
  }

  function closeOpenBubble() {
    if (!STATE.openBubble) return;
    var b = STATE.openBubble.querySelector('.__fw_bubble');
    if (b) b.remove();
    STATE.openBubble = null;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function injectStyles() {
    var css = [
      '#__fw_root { position: fixed; inset: 0; pointer-events: none; z-index: 2147483600; }',
      '#__fw_root * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }',
      '.__fw_toggle { position: fixed; right: 16px; bottom: 16px; pointer-events: auto;',
      '  background: #111; color: #fff; border: 0; border-radius: 999px;',
      '  padding: 10px 16px; font-size: 13px; font-weight: 600; cursor: pointer;',
      '  box-shadow: 0 4px 14px rgba(0,0,0,0.18); }',
      '.__fw_toggle_on { background: #2563eb; }',
      'html.__fw_commenting, html.__fw_commenting body { cursor: crosshair !important; }',
      '.__fw_placed { position: fixed; transform: translate(-50%, -100%); pointer-events: auto; z-index: 2147483601; }',
      '.__fw_pin { width: 28px; height: 28px; border-radius: 999px 999px 999px 2px;',
      '  background: #2563eb; color: #fff; border: 2px solid #fff;',
      '  font-size: 12px; font-weight: 700; cursor: pointer;',
      '  display: flex; align-items: center; justify-content: center;',
      '  box-shadow: 0 2px 6px rgba(0,0,0,0.25); padding: 0; }',
      '.__fw_pin_new { background: #f59e0b; }',
      '.__fw_popover, .__fw_bubble { position: absolute; left: 50%; top: 4px;',
      '  transform: translateX(-50%); margin-top: 4px;',
      '  background: #fff; color: #111; border: 1px solid #e5e7eb;',
      '  border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,0.15);',
      '  padding: 10px; width: 260px; pointer-events: auto; }',
      '.__fw_popover input, .__fw_popover textarea {',
      '  display: block; width: 100%; padding: 6px 8px; margin: 0 0 6px 0;',
      '  border: 1px solid #d1d5db; border-radius: 6px; font-size: 13px;',
      '  font-family: inherit; resize: vertical; }',
      '.__fw_actions { display: flex; gap: 6px; justify-content: flex-end; }',
      '.__fw_actions button { padding: 6px 10px; font-size: 12px; border-radius: 6px;',
      '  border: 1px solid #d1d5db; background: #fff; cursor: pointer; }',
      '.__fw_submit { background: #2563eb; color: #fff; border-color: #2563eb; }',
      '.__fw_submit[disabled] { opacity: 0.6; cursor: default; }',
      '.__fw_author { font-size: 12px; font-weight: 600; margin-bottom: 4px; }',
      '.__fw_text_view { font-size: 13px; white-space: pre-wrap; word-wrap: break-word; }',
      '.__fw_meta { font-size: 11px; color: #6b7280; margin-top: 6px; }',
    ].join('\n');
    var s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }
})();
