/* Admin-only behaviour. Currently: the drag-to-position focal point picker. */
(function () {
  'use strict';

  function initFocusPicker(root) {
    var stage    = root.querySelector('[data-focus-stage]');
    var marker   = root.querySelector('[data-focus-marker]');
    var inputX   = root.querySelector('[data-focus-x]');
    var inputY   = root.querySelector('[data-focus-y]');
    var previews = root.querySelectorAll('[data-focus-preview]');
    var reset    = root.querySelector('[data-focus-reset]');
    if (!stage || !marker || !inputX || !inputY) return;

    var dragging = false;

    function clamp(n) { return Math.min(100, Math.max(0, n)); }

    function apply(x, y) {
      x = Math.round(clamp(x) * 10) / 10;
      y = Math.round(clamp(y) * 10) / 10;

      marker.style.left = x + '%';
      marker.style.top  = y + '%';
      inputX.value = x;
      inputY.value = y;

      for (var i = 0; i < previews.length; i++) {
        previews[i].style.objectPosition = x + '% ' + y + '%';
      }
    }

    // The image is letterboxed inside the stage by object-fit: contain, so the
    // pointer position has to be measured against the *rendered picture*, not the
    // box around it — otherwise the marker drifts on non-square images.
    function pointToPercent(clientX, clientY) {
      var img  = stage.querySelector('img');
      var rect = stage.getBoundingClientRect();
      if (!img || !img.naturalWidth) {
        return { x: ((clientX - rect.left) / rect.width) * 100, y: ((clientY - rect.top) / rect.height) * 100 };
      }

      var scale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
      var drawW = img.naturalWidth * scale;
      var drawH = img.naturalHeight * scale;
      var offX  = (rect.width - drawW) / 2;
      var offY  = (rect.height - drawH) / 2;

      return {
        x: ((clientX - rect.left - offX) / drawW) * 100,
        y: ((clientY - rect.top - offY) / drawH) * 100,
      };
    }

    function moveTo(clientX, clientY) {
      var p = pointToPercent(clientX, clientY);
      apply(p.x, p.y);
    }

    stage.addEventListener('pointerdown', function (e) {
      dragging = true;
      stage.setPointerCapture(e.pointerId);
      stage.classList.add('is-dragging');
      moveTo(e.clientX, e.clientY);
      e.preventDefault();
    });

    stage.addEventListener('pointermove', function (e) {
      if (dragging) moveTo(e.clientX, e.clientY);
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      stage.classList.remove('is-dragging');
      if (e && e.pointerId != null && stage.hasPointerCapture && stage.hasPointerCapture(e.pointerId)) {
        stage.releasePointerCapture(e.pointerId);
      }
    }
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);

    // Keyboard nudging, so this isn't mouse-only.
    stage.addEventListener('keydown', function (e) {
      var step = e.shiftKey ? 10 : 2;
      var x = parseFloat(inputX.value) || 50;
      var y = parseFloat(inputY.value) || 50;
      var handled = true;

      switch (e.key) {
        case 'ArrowLeft':  x -= step; break;
        case 'ArrowRight': x += step; break;
        case 'ArrowUp':    y -= step; break;
        case 'ArrowDown':  y += step; break;
        default: handled = false;
      }
      if (handled) { apply(x, y); e.preventDefault(); }
    });

    if (reset) {
      reset.addEventListener('click', function () { apply(50, 50); });
    }

    // Previews can't position correctly until the image has real dimensions.
    var img = stage.querySelector('img');
    if (img && !img.complete) {
      img.addEventListener('load', function () {
        apply(parseFloat(inputX.value) || 50, parseFloat(inputY.value) || 50);
      });
    }
  }

  function init() {
    var pickers = document.querySelectorAll('[data-focus-picker]');
    for (var i = 0; i < pickers.length; i++) initFocusPicker(pickers[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
