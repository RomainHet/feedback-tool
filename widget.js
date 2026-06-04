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

  // Two layers:
  //   #__fw_root  — position: fixed, holds the toggle button (and any
  //                 floating UI that must stay in the viewport corner).
  //   #__fw_pins  — position: absolute on body, holds pins + composer so they
  //                 scroll with document content.
  var root = document.createElement('div');
  root.id = '__fw_root';
  document.documentElement.appendChild(root);

  var pinLayer = document.createElement('div');
  pinLayer.id = '__fw_pins';
  // Append once body exists.
  function attachPinLayer() {
    if (pinLayer.parentNode) return;
    (document.body || document.documentElement).appendChild(pinLayer);
  }
  if (document.body) attachPinLayer();
  else document.addEventListener('DOMContentLoaded', attachPinLayer);

  // Visual indicators while comment mode is active: a viewport-edge border and
  // a top-left badge. Toggled via the html.__fw_commenting class — see CSS.
  var modeBorder = document.createElement('div');
  modeBorder.className = '__fw_mode_border';
  root.appendChild(modeBorder);
  var modeBadge = document.createElement('div');
  modeBadge.className = '__fw_mode_badge';
  modeBadge.innerHTML =
    '<span class="__fw_mode_dot"></span>' +
    '<span>Comment mode</span>' +
    '<span class="__fw_mode_hint">Esc to exit</span>';
  root.appendChild(modeBadge);

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
      if (e.target.closest('#__fw_pins')) return;
      if (STATE.pending) return;
      e.preventDefault();
      e.stopPropagation();
      var doc = document.documentElement;
      // pageX/pageY include scroll offset → coordinates within the document,
      // not the viewport. Normalize against scrollWidth/scrollHeight so the
      // stored values are responsive to page-size changes between sessions.
      var docW = Math.max(doc.scrollWidth, 1);
      var docH = Math.max(doc.scrollHeight, 1);
      var xPct = (e.pageX / docW) * 100;
      var yPct = (e.pageY / docH) * 100;
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

  // Esc unwinds widget state in order: composer → open bubble → exit mode.
  // Captured at the document level so the host page's keydown handlers don't
  // swallow it before we get a chance to react.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' && e.keyCode !== 27) return;
    if (STATE.pending) {
      STATE.pending.el.remove();
      STATE.pending = null;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (STATE.openBubble) {
      closeOpenBubble();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (STATE.active) {
      setActive(false);
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  // Re-render on route changes.
  var origPush = history.pushState;
  history.pushState = function () {
    var r = origPush.apply(this, arguments);
    load();
    return r;
  };
  window.addEventListener('popstate', load);
  // Re-render on size changes so pins follow content reflow. Also re-render
  // after `load` (images, fonts) since they often grow the document.
  window.addEventListener('resize', renderPins);
  window.addEventListener('load', function () {
    renderPins();
    // Catch late-loading content (async-rendered sections, lazy images).
    setTimeout(renderPins, 600);
  });

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

  // Convert a document-percentage coordinate to absolute pixels for current
  // document size. Re-run on resize / late layout shifts.
  function pctToPx(xPct, yPct) {
    var doc = document.documentElement;
    return {
      x: (Number(xPct) / 100) * doc.scrollWidth,
      y: (Number(yPct) / 100) * doc.scrollHeight,
    };
  }

  function openComposer(xPct, yPct) {
    closeOpenBubble();
    attachPinLayer();
    var wrap = document.createElement('div');
    wrap.className = '__fw_placed __fw_pending';
    positionWrap(wrap, xPct, yPct);
    wrap.innerHTML =
      '<div class="__fw_pin __fw_pin_new">+</div>' +
      '<form class="__fw_popover">' +
      '<div class="__fw_popover_head">New comment</div>' +
      '<input class="__fw_name" placeholder="Your name" maxlength="120" />' +
      '<textarea class="__fw_text" placeholder="Leave a comment" rows="3" maxlength="4000"></textarea>' +
      '<div class="__fw_actions">' +
      '<button type="button" class="__fw_cancel">Cancel</button>' +
      '<button type="submit" class="__fw_submit">Send</button>' +
      '</div>' +
      '</form>';
    pinLayer.appendChild(wrap);
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

  function positionWrap(wrap, xPct, yPct) {
    var p = pctToPx(xPct, yPct);
    wrap.style.left = p.x + 'px';
    wrap.style.top = p.y + 'px';
  }

  function renderPins() {
    if (!pinLayer.parentNode) attachPinLayer();
    // Remove existing rendered pin wrappers (but not the pending composer).
    Array.prototype.slice.call(pinLayer.querySelectorAll('.__fw_placed:not(.__fw_pending)'))
      .forEach(function (n) { n.remove(); });

    STATE.pins.forEach(function (c, i) {
      var wrap = document.createElement('div');
      wrap.className = '__fw_placed';
      positionWrap(wrap, c.x_pct, c.y_pct);
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
        var authorName = c.author || 'Anonymous';
        var absWhen = '';
        try { absWhen = new Date(c.created_at).toLocaleString(); } catch (_) {}
        var relWhen = formatRelTime(c.created_at);
        var avatarColor = colorFromString(authorName);
        var avatarChar = initial(authorName);
        // Trash icon (Feather Icons "trash-2", MIT) — strokes inherit currentColor
        // from .__fw_delete, so hover state tints the icon too.
        var trashSvg =
          '<svg class="__fw_delete_icon" width="13" height="13" viewBox="0 0 24 24" fill="none" ' +
          'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<polyline points="3 6 5 6 21 6"></polyline>' +
          '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>' +
          '<path d="M10 11v6"></path><path d="M14 11v6"></path>' +
          '<path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>' +
          '</svg>';
        bubble.innerHTML =
          '<div class="__fw_bubble_head">' +
            '<span class="__fw_avatar" style="background:' + avatarColor + '" aria-hidden="true">' +
              escapeHtml(avatarChar) +
            '</span>' +
            '<span class="__fw_author">' + escapeHtml(authorName) + '</span>' +
            '<span class="__fw_dot" aria-hidden="true">·</span>' +
            '<span class="__fw_when" title="' + escapeHtml(absWhen) + '">' + escapeHtml(relWhen) + '</span>' +
          '</div>' +
          '<div class="__fw_text_view">' + escapeHtml(c.text) + '</div>' +
          '<div class="__fw_bubble_foot">' +
            '<button type="button" class="__fw_delete" title="Delete comment">' +
              trashSvg +
              '<span class="__fw_delete_label">Delete</span>' +
            '</button>' +
          '</div>';
        wrap.appendChild(bubble);
        STATE.openBubble = wrap;

        var delBtn = bubble.querySelector('.__fw_delete');
        var delLabel = delBtn.querySelector('.__fw_delete_label');
        delBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (!window.confirm('Delete this comment?')) return;
          delBtn.disabled = true;
          delLabel.textContent = 'Deleting…';
          fetch(apiBase + '/api/comments?id=' + encodeURIComponent(c.id), {
            method: 'DELETE',
          })
            .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
            .then(function (res) {
              if (!res.ok) throw new Error(res.j && res.j.error || 'delete failed');
              STATE.pins = STATE.pins.filter(function (p) { return p.id !== c.id; });
              closeOpenBubble();
              renderPins();
            })
            .catch(function (err) {
              console.error('[feedback-widget]', err);
              delBtn.disabled = false;
              delLabel.textContent = 'Delete';
            });
        });
      });
      wrap.appendChild(pin);
      pinLayer.appendChild(wrap);
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

  function initial(name) {
    var s = String(name || '').trim();
    return s ? s.charAt(0).toUpperCase() : '?';
  }

  // djb2-style hash → HSL hue. Same author name always gets the same color.
  function colorFromString(s) {
    var str = String(s || '');
    var hash = 5381;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash |= 0;
    }
    var hue = Math.abs(hash) % 360;
    return 'hsl(' + hue + ', 62%, 50%)';
  }

  function formatRelTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var diff = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diff < 5) return 'just now';
    if (diff < 60) return diff + 's ago';
    var m = Math.floor(diff / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    var days = Math.floor(h / 24);
    if (days < 7) return days + 'd ago';
    try {
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (_) {
      return d.toDateString();
    }
  }

  function injectStyles() {
    // Critical declarations use !important to defend against host-page CSS
    // (e.g. global `button { color: ... }` rules that would erase our text).
    var FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    var css = [
      // --- Layer scaffolding ---
      '#__fw_root { position: fixed; inset: 0; pointer-events: none; z-index: 2147483600; }',
      '#__fw_root *, #__fw_pins * { box-sizing: border-box; font-family: ' + FONT + '; }',
      '#__fw_pins { position: absolute; top: 0; left: 0; width: 0; height: 0; pointer-events: none; z-index: 2147483599; }',

      // --- Toggle button ---
      '.__fw_toggle { position: fixed; right: 16px; bottom: 16px; pointer-events: auto;',
      '  background: #0f172a !important; color: #ffffff !important;',
      '  border: 0 !important; border-radius: 999px !important;',
      '  padding: 10px 18px !important; font-size: 13px !important; font-weight: 600 !important;',
      '  cursor: pointer !important; font-family: ' + FONT + ' !important;',
      '  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.25) !important;',
      '  transition: background 0.15s, transform 0.15s; }',
      '.__fw_toggle:hover { background: #1e293b !important; transform: translateY(-1px); }',
      '.__fw_toggle_on { background: #2563eb !important; box-shadow: 0 8px 24px rgba(37, 99, 235, 0.4) !important; }',
      '.__fw_toggle_on:hover { background: #1d4ed8 !important; }',

      // --- Comment-mode indicators (border + top-left badge) ---
      '.__fw_mode_border, .__fw_mode_badge { display: none !important; }',
      'html.__fw_commenting .__fw_mode_border { display: block !important; }',
      'html.__fw_commenting .__fw_mode_badge { display: inline-flex !important; }',
      '.__fw_mode_border { position: fixed; inset: 0; pointer-events: none; z-index: 2147483598;',
      '  box-shadow: inset 0 0 0 3px #2563eb, inset 0 0 0 6px rgba(37, 99, 235, 0.18); }',
      '.__fw_mode_badge { position: fixed; top: 16px; left: 16px; pointer-events: none; z-index: 2147483602;',
      '  align-items: center; gap: 8px;',
      '  background: #2563eb !important; color: #ffffff !important;',
      '  padding: 8px 14px !important; border-radius: 999px !important;',
      '  font-size: 12px !important; font-weight: 600 !important; font-family: ' + FONT + ' !important;',
      '  box-shadow: 0 8px 24px rgba(37, 99, 235, 0.4) !important; }',
      '.__fw_mode_dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%;',
      '  background: #ffffff; animation: __fw_pulse 1.4s ease-in-out infinite; }',
      '.__fw_mode_hint { opacity: 0.75; font-weight: 500 !important; margin-left: 2px; }',
      '@keyframes __fw_pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }',

      // --- Cursor: crosshair on the host page, sensible cursors inside widget UI ---
      'html.__fw_commenting, html.__fw_commenting * { cursor: crosshair !important; }',
      'html.__fw_commenting #__fw_root, html.__fw_commenting #__fw_root *,',
      'html.__fw_commenting #__fw_pins, html.__fw_commenting #__fw_pins * { cursor: auto !important; }',
      'html.__fw_commenting .__fw_toggle, html.__fw_commenting .__fw_pin,',
      'html.__fw_commenting .__fw_cancel, html.__fw_commenting .__fw_submit,',
      'html.__fw_commenting .__fw_delete { cursor: pointer !important; }',
      'html.__fw_commenting .__fw_name, html.__fw_commenting .__fw_text { cursor: text !important; }',

      // --- Pin placement wrapper ---
      '.__fw_placed { position: absolute; transform: translate(-50%, -100%); pointer-events: auto; z-index: 2147483601; }',

      // --- Pin (numbered bubble / "+") ---
      '.__fw_pin { width: 30px !important; height: 30px !important;',
      '  border-radius: 999px 999px 999px 2px !important;',
      '  background: #2563eb !important; color: #ffffff !important;',
      '  border: 2px solid #ffffff !important;',
      '  font-size: 12px !important; font-weight: 700 !important;',
      '  font-family: ' + FONT + ' !important;',
      '  cursor: pointer; padding: 0 !important;',
      '  display: flex; align-items: center; justify-content: center;',
      '  box-shadow: 0 4px 12px rgba(37, 99, 235, 0.4) !important; }',
      '.__fw_pin_new { background: #f59e0b !important;',
      '  box-shadow: 0 4px 12px rgba(245, 158, 11, 0.45) !important; }',

      // --- Composer + bubble container ---
      '.__fw_popover, .__fw_bubble { position: absolute; left: 50%; top: 6px;',
      '  transform: translateX(-50%); margin-top: 6px;',
      '  background: #ffffff !important; color: #0f172a !important;',
      '  border: 1px solid rgba(15, 23, 42, 0.06) !important;',
      '  border-radius: 12px !important;',
      '  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.18), 0 2px 8px rgba(15, 23, 42, 0.08) !important;',
      '  padding: 14px !important; width: 300px !important; pointer-events: auto;',
      '  font-family: ' + FONT + ' !important; }',

      // --- Composer header ---
      '.__fw_popover_head { font-size: 11px !important; font-weight: 600 !important;',
      '  color: #64748b !important; text-transform: uppercase; letter-spacing: 0.06em;',
      '  margin: 0 0 10px 0 !important; font-family: ' + FONT + ' !important; }',

      // --- Inputs ---
      '.__fw_name, .__fw_text {',
      '  display: block !important; width: 100% !important;',
      '  padding: 9px 11px !important; margin: 0 0 10px 0 !important;',
      '  border: 1px solid #cbd5e1 !important; border-radius: 8px !important;',
      '  font-size: 13px !important; font-family: ' + FONT + ' !important;',
      '  color: #0f172a !important; background: #ffffff !important;',
      '  outline: 0 !important; box-shadow: none !important;',
      '  line-height: 1.4 !important;',
      '  transition: border-color 0.15s, box-shadow 0.15s; }',
      '.__fw_text { resize: vertical !important; min-height: 78px !important; }',
      '.__fw_name:focus, .__fw_text:focus {',
      '  border-color: #2563eb !important;',
      '  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.18) !important; }',
      '.__fw_name::placeholder, .__fw_text::placeholder { color: #94a3b8 !important; opacity: 1 !important; }',

      // --- Action row ---
      '.__fw_actions { display: flex !important; gap: 8px !important;',
      '  justify-content: flex-end !important; align-items: center !important;',
      '  margin: 4px 0 0 0 !important; padding: 0 !important; }',
      '.__fw_cancel {',
      '  padding: 8px 14px !important; font-size: 13px !important; font-weight: 500 !important;',
      '  border-radius: 8px !important; border: 0 !important;',
      '  background: transparent !important; color: #64748b !important;',
      '  cursor: pointer !important; font-family: ' + FONT + ' !important;',
      '  box-shadow: none !important; }',
      '.__fw_cancel:hover { background: #f1f5f9 !important; color: #0f172a !important; }',
      '.__fw_submit {',
      '  padding: 8px 18px !important; font-size: 13px !important; font-weight: 600 !important;',
      '  border-radius: 8px !important; border: 0 !important;',
      '  background: #2563eb !important; color: #ffffff !important;',
      '  cursor: pointer !important; font-family: ' + FONT + ' !important;',
      '  box-shadow: 0 2px 6px rgba(37, 99, 235, 0.35) !important;',
      '  transition: background 0.15s; }',
      '.__fw_submit:hover { background: #1d4ed8 !important; }',
      '.__fw_submit[disabled] { opacity: 0.6 !important; cursor: default !important; background: #2563eb !important; }',

      // --- Bubble (existing comment view) ---
      '.__fw_bubble { width: 320px !important; padding: 14px 16px !important; }',
      '.__fw_bubble_head { display: flex !important; align-items: center !important;',
      '  gap: 8px !important; margin: 0 0 10px 0 !important; }',
      '.__fw_avatar { display: inline-flex !important; align-items: center !important;',
      '  justify-content: center !important; flex-shrink: 0 !important;',
      '  width: 26px !important; height: 26px !important; border-radius: 50% !important;',
      '  color: #ffffff !important; font-size: 12px !important; font-weight: 700 !important;',
      '  letter-spacing: 0 !important; font-family: ' + FONT + ' !important;',
      '  text-transform: uppercase !important;',
      '  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.15) !important; }',
      '.__fw_author { font-size: 13px !important; font-weight: 600 !important;',
      '  color: #0f172a !important; margin: 0 !important;',
      '  font-family: ' + FONT + ' !important; line-height: 1.2 !important;',
      '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 140px; }',
      '.__fw_dot { color: #cbd5e1 !important; font-size: 13px !important;',
      '  font-weight: 400 !important; line-height: 1; user-select: none; }',
      '.__fw_when { font-size: 12px !important; color: #94a3b8 !important;',
      '  font-family: ' + FONT + ' !important; line-height: 1.2 !important;',
      '  cursor: default; margin-left: auto !important; }',
      '.__fw_text_view { font-size: 14px !important; color: #0f172a !important;',
      '  white-space: pre-wrap; word-wrap: break-word;',
      '  line-height: 1.55 !important; margin: 0 !important;',
      '  font-family: ' + FONT + ' !important; }',
      '.__fw_bubble_foot { display: flex !important; align-items: center !important;',
      '  justify-content: flex-end !important; margin-top: 12px !important;',
      '  padding-top: 0 !important; border-top: 0 !important; gap: 6px !important; }',
      '.__fw_delete { display: inline-flex !important; align-items: center !important;',
      '  gap: 5px !important; font-size: 12px !important; font-weight: 500 !important;',
      '  color: #94a3b8 !important; background: transparent !important;',
      '  border: 0 !important; padding: 6px 10px !important; border-radius: 7px !important;',
      '  cursor: pointer !important; font-family: ' + FONT + ' !important;',
      '  box-shadow: none !important; line-height: 1 !important;',
      '  transition: background 0.15s, color 0.15s; }',
      '.__fw_delete:hover { background: #fef2f2 !important; color: #dc2626 !important; }',
      '.__fw_delete[disabled] { opacity: 0.5 !important; cursor: default !important;',
      '  background: transparent !important; color: #94a3b8 !important; }',
      '.__fw_delete_icon { flex-shrink: 0 !important; }',
    ].join('\n');
    var s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }
})();
