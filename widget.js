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
    pins: [],            // every comment on the current pathname (roots + replies)
    pending: null,
    openBubble: null,    // pin wrapper element whose bubble is currently open
    openBubbleRoot: null,// the root comment that bubble represents
    replyingTo: null,    // id of the root currently being replied to (or null)
    panelOpen: false,
    allPins: [],         // every comment across the project (for the All-comments panel)
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

  // Bottom-right dock: a List button (opens the All-comments panel) + the
  // primary Comment toggle. Wrapping them in a dock lets us position the
  // cluster as a single unit while keeping each button individually focusable.
  var dock = document.createElement('div');
  dock.className = '__fw_dock';

  var listBtn = document.createElement('button');
  listBtn.type = 'button';
  listBtn.className = '__fw_list_btn';
  listBtn.title = 'All comments';
  listBtn.setAttribute('aria-label', 'All comments');
  listBtn.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<line x1="8" y1="6" x2="21" y2="6"></line>' +
    '<line x1="8" y1="12" x2="21" y2="12"></line>' +
    '<line x1="8" y1="18" x2="21" y2="18"></line>' +
    '<line x1="3" y1="6" x2="3.01" y2="6"></line>' +
    '<line x1="3" y1="12" x2="3.01" y2="12"></line>' +
    '<line x1="3" y1="18" x2="3.01" y2="18"></line>' +
    '</svg>' +
    '<span class="__fw_list_count" hidden>0</span>';
  listBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (STATE.panelOpen) closePanel(); else openPanel();
  });
  dock.appendChild(listBtn);

  var toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = '__fw_toggle';
  toggle.textContent = 'Comment';
  toggle.addEventListener('click', function (e) {
    e.stopPropagation();
    setActive(!STATE.active);
  });
  dock.appendChild(toggle);
  root.appendChild(dock);

  // All-comments panel — slides in from the right. Lives on the root layer so
  // pointer-events stay opt-in for descendants.
  var panel = document.createElement('aside');
  panel.className = '__fw_panel';
  panel.setAttribute('aria-hidden', 'true');
  panel.innerHTML =
    '<div class="__fw_panel_head">' +
      '<div class="__fw_panel_title">' +
        '<span>All comments</span>' +
        '<span class="__fw_panel_count">0</span>' +
      '</div>' +
      '<button type="button" class="__fw_panel_close" title="Close (Esc)" aria-label="Close panel">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<line x1="18" y1="6" x2="6" y2="18"></line>' +
        '<line x1="6" y1="6" x2="18" y2="18"></line>' +
        '</svg>' +
      '</button>' +
    '</div>' +
    '<div class="__fw_panel_body"></div>';
  root.appendChild(panel);
  var panelBody = panel.querySelector('.__fw_panel_body');
  var panelCount = panel.querySelector('.__fw_panel_count');
  var listCount = listBtn.querySelector('.__fw_list_count');
  panel.querySelector('.__fw_panel_close').addEventListener('click', closePanel);

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
    if (STATE.replyingTo && STATE.openBubble) {
      // Collapse the reply composer back to the Reply button without closing
      // the whole thread bubble.
      STATE.replyingTo = null;
      refreshOpenBubble();
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
    if (STATE.panelOpen) {
      closePanel();
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
      '<div class="__fw_form_error" hidden></div>' +
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
          if (!res.ok) throw new Error(errorMessage(res) || 'Couldn\'t save comment.');
          STATE.pins.push(res.j);
          wrap.remove();
          STATE.pending = null;
          renderPins();
        })
        .catch(function (err) {
          console.error('[feedback-widget]', err);
          submitBtn.disabled = false;
          submitBtn.textContent = 'Send';
          showFormError(wrap.querySelector('.__fw_form_error'), err);
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
        // If we arrived via a panel jump from another page, the URL has a
        // #fw=<id> hash — scroll that pin into view and open its bubble.
        focusPinFromHash();
      })
      .catch(function (err) {
        console.error('[feedback-widget]', err);
      });
    // Also refresh the project-wide count in the background, so the dock
    // badge stays accurate without forcing the panel open.
    fetchAllPins().catch(function () { /* swallow — count just stays stale */ });
  }

  function positionWrap(wrap, xPct, yPct) {
    var p = pctToPx(xPct, yPct);
    wrap.style.left = p.x + 'px';
    wrap.style.top = p.y + 'px';
  }

  // Pins on the page are only the ROOTS of each thread. Replies live at the
  // same coordinates as their root and are shown inside the bubble, not as
  // separate pins.
  function rootsOf(pins) {
    return pins.filter(function (p) { return !p.parent_id; });
  }

  function repliesOf(pins, parentId) {
    return pins
      .filter(function (p) { return p.parent_id === parentId; })
      .sort(function (a, b) { return new Date(a.created_at) - new Date(b.created_at); });
  }

  function renderPins() {
    if (!pinLayer.parentNode) attachPinLayer();
    // Remove existing rendered pin wrappers (but not the pending composer).
    Array.prototype.slice.call(pinLayer.querySelectorAll('.__fw_placed:not(.__fw_pending)'))
      .forEach(function (n) { n.remove(); });

    rootsOf(STATE.pins).forEach(function (root, i) {
      var wrap = document.createElement('div');
      wrap.className = '__fw_placed';
      positionWrap(wrap, root.x_pct, root.y_pct);
      wrap.dataset.id = root.id;

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
        openBubbleFor(root, wrap);
      });
      wrap.appendChild(pin);
      pinLayer.appendChild(wrap);
    });
  }

  // -------- Bubble (thread view) --------

  // Feather Icons (MIT). currentColor lets the host button tint them on hover.
  var SVG_TRASH =
    '<svg class="__fw_icon" width="13" height="13" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="3 6 5 6 21 6"></polyline>' +
    '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>' +
    '<path d="M10 11v6"></path><path d="M14 11v6"></path>' +
    '<path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>' +
    '</svg>';
  var SVG_REPLY =
    '<svg class="__fw_icon" width="13" height="13" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="9 17 4 12 9 7"></polyline>' +
    '<path d="M20 18v-2a4 4 0 0 0-4-4H4"></path>' +
    '</svg>';

  function openBubbleFor(root, wrap) {
    closeOpenBubble();
    var bubble = buildBubble(root);
    wrap.appendChild(bubble);
    // Force the wrap visible even when comment mode is off — this is what
    // makes panel-jump work without flipping the user into comment mode.
    wrap.classList.add('__fw_placed_visible');
    STATE.openBubble = wrap;
    STATE.openBubbleRoot = root;
  }

  function refreshOpenBubble() {
    if (!STATE.openBubble || !STATE.openBubbleRoot) return;
    var wrap = STATE.openBubble;
    var root = STATE.openBubbleRoot;
    // Pull the freshest root from state in case it was updated.
    var freshRoot = STATE.pins.find(function (p) { return p.id === root.id; }) || root;
    var old = wrap.querySelector('.__fw_bubble');
    var next = buildBubble(freshRoot);
    if (old) old.replaceWith(next); else wrap.appendChild(next);
  }

  function buildBubble(root) {
    var bubble = document.createElement('div');
    bubble.className = '__fw_bubble';

    var thread = document.createElement('div');
    thread.className = '__fw_thread';
    thread.appendChild(buildThreadRow(root, true));

    var replies = repliesOf(STATE.pins, root.id);
    if (replies.length) {
      var replyList = document.createElement('div');
      replyList.className = '__fw_thread_replies';
      replies.forEach(function (r) {
        replyList.appendChild(buildThreadRow(r, false));
      });
      thread.appendChild(replyList);
    }
    bubble.appendChild(thread);

    // Reply area — collapsed button, or expanded composer if user is replying
    // to this thread.
    var area = document.createElement('div');
    area.className = '__fw_reply_area';
    bubble.appendChild(area);
    if (STATE.replyingTo === root.id) {
      renderReplyForm(area, root);
    } else {
      renderReplyButton(area, root);
    }

    return bubble;
  }

  function buildThreadRow(c, isRoot) {
    var row = document.createElement('div');
    row.className = '__fw_thread_row' + (isRoot ? ' __fw_thread_root' : ' __fw_thread_reply_row');
    row.dataset.id = c.id;
    var authorName = c.author || 'Anonymous';
    var absWhen = '';
    try { absWhen = new Date(c.created_at).toLocaleString(); } catch (_) {}
    var relWhen = formatRelTime(c.created_at);
    var avatarColor = colorFromString(authorName);
    var avatarChar = initial(authorName);
    row.innerHTML =
      '<div class="__fw_thread_head">' +
        '<span class="__fw_avatar' + (isRoot ? '' : ' __fw_avatar_sm') +
          '" style="background:' + avatarColor + '" aria-hidden="true">' +
          escapeHtml(avatarChar) +
        '</span>' +
        '<span class="__fw_author">' + escapeHtml(authorName) + '</span>' +
        '<span class="__fw_when" title="' + escapeHtml(absWhen) + '">' + escapeHtml(relWhen) + '</span>' +
        '<button type="button" class="__fw_row_delete" title="Delete">' + SVG_TRASH + '</button>' +
      '</div>' +
      '<div class="__fw_thread_text">' + escapeHtml(c.text) + '</div>';

    var delBtn = row.querySelector('.__fw_row_delete');
    delBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (!window.confirm(isRoot && repliesOf(STATE.pins, c.id).length
        ? 'Delete this comment and all its replies?'
        : 'Delete this comment?')) return;
      delBtn.disabled = true;
      fetch(apiBase + '/api/comments?id=' + encodeURIComponent(c.id), { method: 'DELETE' })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (!res.ok) throw new Error(errorMessage(res) || 'Couldn\'t delete comment.');
          // Drop the deleted row and (cascade) any replies under it.
          STATE.pins = STATE.pins.filter(function (p) {
            return p.id !== c.id && p.parent_id !== c.id;
          });
          STATE.allPins = STATE.allPins.filter(function (p) {
            return p.id !== c.id && p.parent_id !== c.id;
          });
          if (isRoot) {
            closeOpenBubble();
            renderPins();
          } else {
            refreshOpenBubble();
          }
          if (STATE.panelOpen) renderPanel();
          updateDockCount();
        })
        .catch(function (err) {
          console.error('[feedback-widget]', err);
          delBtn.disabled = false;
        });
    });

    return row;
  }

  function renderReplyButton(area, root) {
    area.innerHTML = '';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = '__fw_reply_open';
    btn.innerHTML = SVG_REPLY + '<span>Reply</span>';
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      STATE.replyingTo = root.id;
      renderReplyForm(area, root);
    });
    area.appendChild(btn);
  }

  function renderReplyForm(area, root) {
    area.innerHTML = '';
    var form = document.createElement('form');
    form.className = '__fw_reply_form';
    form.innerHTML =
      '<input class="__fw_name __fw_reply_name" placeholder="Your name" maxlength="120" />' +
      '<textarea class="__fw_text __fw_reply_text" placeholder="Write a reply…" rows="2" maxlength="4000"></textarea>' +
      '<div class="__fw_form_error" hidden></div>' +
      '<div class="__fw_actions">' +
      '<button type="button" class="__fw_cancel">Cancel</button>' +
      '<button type="submit" class="__fw_submit">Reply</button>' +
      '</div>';
    area.appendChild(form);
    var nameInput = form.querySelector('.__fw_name');
    var textInput = form.querySelector('.__fw_text');
    try {
      var savedName = window.localStorage && localStorage.getItem('__fw_author');
      if (savedName) nameInput.value = savedName;
    } catch (_) {}
    setTimeout(function () {
      (nameInput.value ? textInput : nameInput).focus();
    }, 0);

    form.querySelector('.__fw_cancel').addEventListener('click', function (e) {
      e.stopPropagation();
      STATE.replyingTo = null;
      renderReplyButton(area, root);
    });

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var author = nameInput.value.trim();
      var text = textInput.value.trim();
      if (!text) { textInput.focus(); return; }
      try { if (author) localStorage.setItem('__fw_author', author); } catch (_) {}
      var submitBtn = form.querySelector('.__fw_submit');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';
      fetch(apiBase + '/api/comments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          pathname: root.pathname,
          x_pct: root.x_pct,
          y_pct: root.y_pct,
          text: text,
          author: author || null,
          parent_id: root.id,
        }),
      })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (!res.ok) throw new Error(errorMessage(res) || 'Couldn\'t post reply.');
          STATE.pins.push(res.j);
          STATE.allPins.push(res.j);
          STATE.replyingTo = null;
          refreshOpenBubble();
          if (STATE.panelOpen) renderPanel();
          updateDockCount();
        })
        .catch(function (err) {
          console.error('[feedback-widget]', err);
          submitBtn.disabled = false;
          submitBtn.textContent = 'Reply';
          showFormError(form.querySelector('.__fw_form_error'), err);
        });
    });
  }

  function closeOpenBubble() {
    STATE.replyingTo = null;
    if (!STATE.openBubble) return;
    var b = STATE.openBubble.querySelector('.__fw_bubble');
    if (b) b.remove();
    STATE.openBubble.classList.remove('__fw_placed_visible');
    STATE.openBubble = null;
    STATE.openBubbleRoot = null;
  }

  // -------- All-comments panel --------

  function fetchAllPins() {
    return fetch(apiBase + '/api/comments?project_id=' + encodeURIComponent(projectId))
      .then(function (r) { return r.json(); })
      .then(function (rows) {
        STATE.allPins = Array.isArray(rows) ? rows : [];
        updateDockCount();
        if (STATE.panelOpen) renderPanel();
        return STATE.allPins;
      });
  }

  function updateDockCount() {
    var n = STATE.allPins.length;
    if (n > 0) {
      listCount.hidden = false;
      listCount.textContent = n > 99 ? '99+' : String(n);
    } else {
      listCount.hidden = true;
    }
    panelCount.textContent = String(n);
  }

  function openPanel() {
    STATE.panelOpen = true;
    panel.classList.add('__fw_panel_open');
    panel.setAttribute('aria-hidden', 'false');
    listBtn.classList.add('__fw_list_btn_on');
    // Render whatever we have, then refresh from the server.
    renderPanel();
    fetchAllPins().catch(function (err) {
      console.error('[feedback-widget]', err);
    });
  }

  function closePanel() {
    STATE.panelOpen = false;
    panel.classList.remove('__fw_panel_open');
    panel.setAttribute('aria-hidden', 'true');
    listBtn.classList.remove('__fw_list_btn_on');
  }

  function renderPanel() {
    panelBody.innerHTML = '';
    updateDockCount();
    if (!STATE.allPins.length) {
      var empty = document.createElement('div');
      empty.className = '__fw_panel_empty';
      empty.innerHTML =
        '<div class="__fw_panel_empty_title">No comments yet</div>' +
        '<div class="__fw_panel_empty_sub">Click <strong>Comment</strong> below, then click anywhere on the page to drop a pin.</div>';
      panelBody.appendChild(empty);
      return;
    }
    // Group by pathname; current path bubbles to the top.
    var groups = {};
    STATE.allPins.forEach(function (c) {
      var key = c.pathname || '/';
      if (!groups[key]) groups[key] = [];
      groups[key].push(c);
    });
    var paths = Object.keys(groups).sort(function (a, b) {
      if (a === location.pathname) return -1;
      if (b === location.pathname) return 1;
      return a.localeCompare(b);
    });
    paths.forEach(function (p) {
      var isHere = (p === location.pathname);
      var group = document.createElement('section');
      group.className = '__fw_panel_group' + (isHere ? ' __fw_panel_group_here' : '');

      var roots = rootsOf(groups[p]);

      // Header: optional "This page" eyebrow, then path + thread count.
      // Count is THREADS (root comments), not all comments — replies are
      // shown nested under their root in the list below.
      var head = document.createElement('header');
      head.className = '__fw_panel_path';
      var inner = '';
      if (isHere) {
        inner += '<div class="__fw_panel_path_eyebrow">This page</div>';
      }
      inner +=
        '<div class="__fw_panel_path_row">' +
          '<span class="__fw_panel_path_text" title="' + escapeHtml(p) + '">' + escapeHtml(p) + '</span>' +
          '<span class="__fw_panel_path_count" title="' + roots.length + ' thread' + (roots.length === 1 ? '' : 's') + '">' +
            roots.length +
          '</span>' +
        '</div>';
      head.innerHTML = inner;
      group.appendChild(head);

      var items = document.createElement('div');
      items.className = '__fw_panel_items';
      roots.forEach(function (root) {
        items.appendChild(makePanelItem(root, true, null));
        var replies = repliesOf(groups[p], root.id);
        if (replies.length) {
          var nest = document.createElement('div');
          nest.className = '__fw_panel_replies';
          replies.forEach(function (r) {
            nest.appendChild(makePanelItem(r, false, root));
          });
          items.appendChild(nest);
        }
      });
      group.appendChild(items);

      panelBody.appendChild(group);
    });
  }

  // jumpTarget = the root whose pin to focus when this item is clicked. For
  // root items, that's the item itself; for reply items, it's the parent root
  // (replies share location with their root).
  function makePanelItem(c, isRoot, parentRoot) {
    var item = document.createElement('button');
    item.type = 'button';
    item.className = '__fw_panel_item' + (isRoot ? ' __fw_panel_item_root' : ' __fw_panel_item_reply');
    item.title = isRoot ? 'Jump to this thread' : 'Jump to the thread';
    var authorName = c.author || 'Anonymous';
    var avatarColor = colorFromString(authorName);
    var avatarChar = initial(authorName);
    var relWhen = formatRelTime(c.created_at);
    var absWhen = '';
    try { absWhen = new Date(c.created_at).toLocaleString(); } catch (_) {}
    // Reply badge on root items so users can see at a glance which threads
    // have follow-ups.
    var replyBadge = '';
    if (isRoot) {
      var rCount = repliesOf(STATE.allPins, c.id).length;
      if (rCount) {
        replyBadge =
          '<span class="__fw_panel_replycount" title="' + rCount + ' repl' +
          (rCount === 1 ? 'y' : 'ies') + '">' + SVG_REPLY + rCount + '</span>';
      }
    }
    item.innerHTML =
      '<div class="__fw_panel_item_head">' +
        '<span class="__fw_avatar __fw_avatar_sm" style="background:' + avatarColor + '" aria-hidden="true">' +
          escapeHtml(avatarChar) +
        '</span>' +
        '<span class="__fw_panel_item_author">' + escapeHtml(authorName) + '</span>' +
        '<span class="__fw_panel_item_when" title="' + escapeHtml(absWhen) + '">' + escapeHtml(relWhen) + '</span>' +
      '</div>' +
      '<div class="__fw_panel_item_text">' + escapeHtml(c.text) + '</div>' +
      replyBadge;
    item.addEventListener('click', function () {
      jumpToComment(isRoot ? c : (parentRoot || c));
    });
    return item;
  }

  // Same path → close panel and focus the pin. Different path → navigate
  // there with a #fw=<id> hash, which the widget picks up after the page
  // loads (see focusPinFromHash).
  function jumpToComment(c) {
    if ((c.pathname || '/') === location.pathname) {
      closePanel();
      setTimeout(function () { focusPin(c.id); }, 220);
    } else {
      location.href = (c.pathname || '/') + '#fw=' + encodeURIComponent(c.id);
    }
  }

  function focusPin(id) {
    var wrap = pinLayer.querySelector('.__fw_placed[data-id="' + id.replace(/"/g, '\\"') + '"]');
    if (!wrap) return;
    var pin = wrap.querySelector('.__fw_pin');
    if (!pin) return;
    // Pins are hidden outside comment mode; make this one visible before we
    // try to scroll to it (scrollIntoView on a display:none element no-ops).
    wrap.classList.add('__fw_placed_visible');
    try {
      pin.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (_) {
      pin.scrollIntoView();
    }
    pin.classList.add('__fw_pin_focus');
    setTimeout(function () { pin.classList.remove('__fw_pin_focus'); }, 1400);
    // Auto-open the bubble after the scroll settles — openBubbleFor will
    // also set __fw_placed_visible, so the wrap stays visible until the
    // bubble is closed.
    setTimeout(function () { pin.click(); }, 380);
  }

  function focusPinFromHash() {
    var m = /^#fw=(.+)$/.exec(location.hash || '');
    if (!m) return;
    var id = decodeURIComponent(m[1]);
    // Wait a tick — pins were just rendered, but layout may still be settling.
    setTimeout(function () { focusPin(id); }, 80);
    // Strip the hash so reloads / share-back don't re-trigger the jump.
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch (_) {}
  }

  // Extract the most useful error string from whatever shape the server sent.
  // Our /api/comments normalizes to {error}, but if anything in the chain
  // leaks the raw Supabase shape ({code, message, hint}) we still want to
  // surface a readable message rather than fall through to a generic string.
  function errorMessage(res) {
    if (!res) return '';
    var j = res.j || res;
    if (!j || typeof j !== 'object') return '';
    return j.error || j.message || j.hint || (j.code ? ('error ' + j.code) : '');
  }

  function showFormError(el, err) {
    if (!el) return;
    var msg = (err && err.message) ? String(err.message) : 'Request failed.';
    // Friendly hint for the most common preventable failure: forgot to run
    // the schema migration after adding threading support.
    if (/parent_id|schema cache|PGRST204/i.test(msg)) {
      msg = "Couldn't save: the database is missing the `parent_id` column. " +
            "Run the latest schema.sql migration in Supabase, then try again.";
    }
    el.textContent = msg;
    el.hidden = false;
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
    // Softer, more muted than full-chroma — readable against any bubble bg
    // and less aggressive when many avatars stack in the panel.
    return 'hsl(' + hue + ', 52%, 54%)';
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

      // --- Bottom-right dock (list button + comment toggle) ---
      '.__fw_dock { position: fixed; right: 16px; bottom: 16px; pointer-events: none;',
      '  display: flex; align-items: center; gap: 8px; z-index: 2147483600; }',
      '.__fw_list_btn { pointer-events: auto;',
      '  width: 40px !important; height: 40px !important; position: relative;',
      '  background: #ffffff !important; color: #475569 !important;',
      '  border: 1px solid rgba(15, 23, 42, 0.08) !important; border-radius: 50% !important;',
      '  padding: 0 !important; display: inline-flex !important;',
      '  align-items: center !important; justify-content: center !important;',
      '  cursor: pointer !important; font-family: ' + FONT + ' !important;',
      '  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.18) !important;',
      '  transition: background 0.15s, color 0.15s, transform 0.15s; }',
      '.__fw_list_btn:hover { background: #f8fafc !important; color: #0f172a !important; transform: translateY(-1px); }',
      '.__fw_list_btn_on { background: #0f172a !important; color: #ffffff !important;',
      '  border-color: #0f172a !important; }',
      '.__fw_list_btn_on:hover { background: #1e293b !important; color: #ffffff !important; }',
      '.__fw_list_count { position: absolute; top: -4px; right: -4px;',
      '  min-width: 18px; height: 18px; padding: 0 5px;',
      '  background: #2563eb !important; color: #ffffff !important;',
      '  border: 2px solid #ffffff !important; border-radius: 999px !important;',
      '  font-size: 10px !important; font-weight: 700 !important;',
      '  font-family: ' + FONT + ' !important;',
      '  display: inline-flex !important; align-items: center !important; justify-content: center !important;',
      '  line-height: 1 !important; box-sizing: border-box !important; }',

      // --- Toggle button (now a child of .__fw_dock; no fixed positioning) ---
      '.__fw_toggle { pointer-events: auto; position: static !important;',
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
      'html.__fw_commenting .__fw_toggle, html.__fw_commenting .__fw_list_btn,',
      'html.__fw_commenting .__fw_panel_close, html.__fw_commenting .__fw_panel_item,',
      'html.__fw_commenting .__fw_pin,',
      'html.__fw_commenting .__fw_cancel, html.__fw_commenting .__fw_submit,',
      'html.__fw_commenting .__fw_delete { cursor: pointer !important; }',
      'html.__fw_commenting .__fw_name, html.__fw_commenting .__fw_text { cursor: text !important; }',

      // --- Pin placement wrapper ---
      // Pins are hidden by default; visible only when comment mode is on, or
      // when a specific pin is focused/has its bubble open (panel-jump). The
      // dock badge keeps showing the total count as a discovery signal.
      '.__fw_placed { position: absolute; transform: translate(-50%, -100%); pointer-events: auto;',
      '  z-index: 2147483601; display: none; }',
      'html.__fw_commenting .__fw_placed,',
      '.__fw_placed.__fw_placed_visible,',
      '.__fw_placed.__fw_pending { display: block; }',

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
      '.__fw_form_error { display: block; margin: 0 0 8px 0 !important;',
      '  padding: 8px 10px !important; border-radius: 8px !important;',
      '  background: #fef2f2 !important; color: #b91c1c !important;',
      '  font-size: 12px !important; line-height: 1.4 !important;',
      '  font-family: ' + FONT + ' !important;',
      '  border: 1px solid rgba(220, 38, 38, 0.18) !important; }',
      '.__fw_form_error[hidden] { display: none !important; }',

      // --- Bubble shell + shared avatar/author/when ---
      '.__fw_bubble { width: 340px !important; padding: 14px 16px 12px !important; }',
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
      '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px; }',
      '.__fw_when { font-size: 12px !important; color: #94a3b8 !important;',
      '  font-family: ' + FONT + ' !important; line-height: 1.2 !important;',
      '  cursor: default; margin-left: auto !important; flex-shrink: 0; }',

      // --- Thread (list of comment rows in the bubble) ---
      '.__fw_thread { display: block; }',
      '.__fw_thread_row { display: block; margin-bottom: 10px; }',
      '.__fw_thread_row:last-child { margin-bottom: 0; }',
      '.__fw_thread_head { display: flex !important; align-items: center !important;',
      '  gap: 8px !important; margin: 0 0 4px 0 !important; }',
      '.__fw_thread_text { font-size: 14px !important; color: #0f172a !important;',
      '  white-space: pre-wrap; word-wrap: break-word;',
      '  line-height: 1.55 !important; margin: 0 0 0 34px !important;',
      '  font-family: ' + FONT + ' !important; }',
      '.__fw_thread_reply_row .__fw_thread_text { font-size: 13px !important; color: #334155 !important; margin-left: 30px !important; }',

      // Replies are indented under the root with a soft left rule.
      '.__fw_thread_replies { margin: 10px 0 10px 13px !important;',
      '  padding: 4px 0 4px 14px !important;',
      '  border-left: 2px solid rgba(15, 23, 42, 0.08) !important; }',

      // Per-row delete (small icon button on the right of each head row).
      '.__fw_row_delete { width: 26px !important; height: 26px !important;',
      '  display: inline-flex !important; align-items: center !important; justify-content: center !important;',
      '  background: transparent !important; color: #cbd5e1 !important;',
      '  border: 0 !important; border-radius: 6px !important; padding: 0 !important;',
      '  cursor: pointer !important; font-family: ' + FONT + ' !important; box-shadow: none !important;',
      '  flex-shrink: 0; transition: background 0.12s, color 0.12s; }',
      '.__fw_thread_row:hover .__fw_row_delete { color: #94a3b8 !important; }',
      '.__fw_row_delete:hover { background: #fef2f2 !important; color: #dc2626 !important; }',
      '.__fw_row_delete[disabled] { opacity: 0.5 !important; cursor: default !important; }',

      // --- Reply area ---
      '.__fw_reply_area { margin-top: 12px !important;',
      '  padding-top: 12px !important; border-top: 1px solid rgba(15, 23, 42, 0.06) !important; }',
      '.__fw_reply_open { display: inline-flex !important; align-items: center !important; gap: 6px !important;',
      '  padding: 7px 12px !important; font-size: 13px !important; font-weight: 600 !important;',
      '  background: #f1f5f9 !important; color: #334155 !important;',
      '  border: 0 !important; border-radius: 8px !important;',
      '  cursor: pointer !important; font-family: ' + FONT + ' !important;',
      '  box-shadow: none !important; transition: background 0.12s, color 0.12s; }',
      '.__fw_reply_open:hover { background: #e2e8f0 !important; color: #0f172a !important; }',
      '.__fw_reply_form { display: block; }',
      '.__fw_reply_form .__fw_actions { margin-top: 4px !important; }',

      // --- Pin "focus" pulse (used when jumping to a pin from the panel) ---
      '@keyframes __fw_pin_pulse {',
      '  0%   { transform: scale(1);   box-shadow: 0 4px 12px rgba(37, 99, 235, 0.4), 0 0 0 0   rgba(37, 99, 235, 0.55); }',
      '  60%  { transform: scale(1.35); box-shadow: 0 4px 16px rgba(37, 99, 235, 0.5), 0 0 0 18px rgba(37, 99, 235, 0);    }',
      '  100% { transform: scale(1);   box-shadow: 0 4px 12px rgba(37, 99, 235, 0.4), 0 0 0 0   rgba(37, 99, 235, 0);    }',
      '}',
      '.__fw_pin_focus { animation: __fw_pin_pulse 1.2s ease-out !important; }',

      // --- All-comments side panel ---
      '.__fw_panel { position: fixed; top: 0; right: 0; bottom: 0;',
      '  width: 380px; max-width: 92vw;',
      '  background: #ffffff !important; color: #0f172a !important;',
      '  border-left: 1px solid rgba(15, 23, 42, 0.08) !important;',
      '  box-shadow: -16px 0 40px rgba(15, 23, 42, 0.14) !important;',
      '  z-index: 2147483603; pointer-events: auto;',
      '  transform: translateX(100%); transition: transform 0.25s ease;',
      '  display: flex; flex-direction: column;',
      '  font-family: ' + FONT + ' !important; }',
      '.__fw_panel_open { transform: translateX(0); }',

      '.__fw_panel_head { display: flex; align-items: center; justify-content: space-between;',
      '  padding: 16px 16px 14px 18px;',
      '  border-bottom: 1px solid rgba(15, 23, 42, 0.06); }',
      '.__fw_panel_title { display: flex; align-items: center; gap: 8px;',
      '  font-size: 15px !important; font-weight: 600 !important; color: #0f172a !important; }',
      '.__fw_panel_count { display: inline-flex; align-items: center; justify-content: center;',
      '  min-width: 22px; height: 22px; padding: 0 7px;',
      '  background: #f1f5f9 !important; color: #475569 !important;',
      '  border-radius: 999px !important;',
      '  font-size: 11px !important; font-weight: 600 !important; line-height: 1 !important; }',
      '.__fw_panel_close { width: 32px !important; height: 32px !important;',
      '  background: transparent !important; color: #64748b !important;',
      '  border: 0 !important; border-radius: 8px !important; padding: 0 !important;',
      '  display: inline-flex; align-items: center; justify-content: center;',
      '  cursor: pointer !important; transition: background 0.15s, color 0.15s; }',
      '.__fw_panel_close:hover { background: #f1f5f9 !important; color: #0f172a !important; }',

      '.__fw_panel_body { flex: 1; overflow-y: auto; padding: 14px 14px 20px; background: #fafbfc; }',
      '.__fw_panel_empty { padding: 40px 16px; text-align: center; color: #64748b; }',
      '.__fw_panel_empty_title { font-size: 14px !important; font-weight: 600 !important;',
      '  color: #0f172a !important; margin-bottom: 6px; }',
      '.__fw_panel_empty_sub { font-size: 13px !important; line-height: 1.5; }',

      // --- Group card: each path is a self-contained card ---
      '.__fw_panel_group { background: #ffffff !important;',
      '  border: 1px solid rgba(15, 23, 42, 0.08) !important;',
      '  border-radius: 12px !important; margin-bottom: 12px !important;',
      '  overflow: hidden; }',
      '.__fw_panel_group_here { border-color: rgba(37, 99, 235, 0.35) !important;',
      '  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.08) !important; }',

      // --- Group header (path label) ---
      '.__fw_panel_path { padding: 12px 14px !important; background: #f8fafc !important;',
      '  border-bottom: 1px solid rgba(15, 23, 42, 0.06) !important; }',
      '.__fw_panel_group_here .__fw_panel_path { background: #eff6ff !important;',
      '  border-bottom-color: rgba(37, 99, 235, 0.18) !important; }',
      '.__fw_panel_path_eyebrow { display: block; font-size: 10px !important;',
      '  font-weight: 700 !important; color: #2563eb !important;',
      '  text-transform: uppercase !important; letter-spacing: 0.08em !important;',
      '  margin-bottom: 5px !important; font-family: ' + FONT + ' !important; }',
      '.__fw_panel_path_row { display: flex !important; align-items: center !important; gap: 8px !important; }',
      '.__fw_panel_path_text { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;',
      '  font-size: 12px !important; font-weight: 600 !important; color: #334155 !important;',
      '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; min-width: 0; }',
      '.__fw_panel_group_here .__fw_panel_path_text { color: #1e3a8a !important; }',
      '.__fw_panel_path_count { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;',
      '  min-width: 22px; height: 22px; padding: 0 8px;',
      '  background: rgba(15, 23, 42, 0.06) !important; color: #475569 !important;',
      '  border-radius: 999px !important;',
      '  font-size: 11px !important; font-weight: 700 !important;',
      '  font-family: ' + FONT + ' !important; line-height: 1 !important; }',
      '.__fw_panel_group_here .__fw_panel_path_count { background: rgba(37, 99, 235, 0.15) !important;',
      '  color: #1d4ed8 !important; }',

      // --- Comment rows inside a group ---
      '.__fw_panel_items { background: #ffffff !important; }',
      '.__fw_panel_item { display: block !important; width: 100% !important;',
      '  text-align: left !important; background: transparent !important;',
      '  border: 0 !important; border-radius: 0 !important;',
      '  padding: 12px 14px !important; margin: 0 !important;',
      '  cursor: pointer !important; font-family: ' + FONT + ' !important;',
      '  box-shadow: none !important; position: relative;',
      '  transition: background 0.12s; }',
      '.__fw_panel_item + .__fw_panel_item { border-top: 1px solid rgba(15, 23, 42, 0.05) !important; }',
      '.__fw_panel_item:hover { background: #f8fafc !important; }',
      '.__fw_panel_group_here .__fw_panel_item:hover { background: #eff6ff !important; }',

      // --- Smaller avatar for the panel context ---
      '.__fw_avatar_sm { width: 22px !important; height: 22px !important; font-size: 10px !important; }',

      '.__fw_panel_item_head { display: flex !important; align-items: center !important;',
      '  gap: 8px !important; margin-bottom: 4px !important; }',
      '.__fw_panel_item_author { font-size: 13px !important; font-weight: 600 !important;',
      '  color: #0f172a !important; line-height: 1.2 !important;',
      '  font-family: ' + FONT + ' !important;',
      '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '.__fw_panel_item_when { margin-left: auto !important; flex-shrink: 0;',
      '  font-size: 11px !important; color: #94a3b8 !important;',
      '  font-family: ' + FONT + ' !important; }',
      '.__fw_panel_item_text { font-size: 13px !important; color: #475569 !important;',
      '  line-height: 1.5 !important; margin: 0 0 0 30px !important;',
      '  display: -webkit-box !important; -webkit-line-clamp: 2 !important;',
      '  -webkit-box-orient: vertical !important; overflow: hidden !important;',
      '  word-wrap: break-word !important; font-family: ' + FONT + ' !important; }',

      // --- Panel replies (indented under a root) ---
      '.__fw_panel_replies { margin: 0 0 0 26px !important;',
      '  padding-left: 14px !important;',
      '  border-left: 2px solid rgba(15, 23, 42, 0.08) !important; }',
      '.__fw_panel_group_here .__fw_panel_replies { border-left-color: rgba(37, 99, 235, 0.22) !important; }',
      '.__fw_panel_item_reply { padding: 8px 14px 8px 12px !important; }',
      '.__fw_panel_item_reply + .__fw_panel_item_reply { border-top: 1px solid rgba(15, 23, 42, 0.05) !important; }',
      '.__fw_panel_item_reply .__fw_panel_item_text { font-size: 12px !important; margin-left: 26px !important; }',
      '.__fw_panel_item_reply .__fw_panel_item_author { font-size: 12px !important; }',

      // --- Reply count badge on a root in the panel ---
      '.__fw_panel_replycount { display: inline-flex !important; align-items: center !important;',
      '  gap: 4px !important; margin: 8px 0 0 30px !important;',
      '  padding: 2px 8px !important; border-radius: 999px !important;',
      '  background: #f1f5f9 !important; color: #64748b !important;',
      '  font-size: 11px !important; font-weight: 600 !important;',
      '  font-family: ' + FONT + ' !important; }',
      '.__fw_panel_replycount .__fw_icon { width: 11px !important; height: 11px !important; }',
    ].join('\n');
    var s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }
})();
