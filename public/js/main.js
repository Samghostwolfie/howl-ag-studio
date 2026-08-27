document.addEventListener('DOMContentLoaded', function () {
  /* ---------- mobile nav ---------- */
  var toggle = document.getElementById('navToggle');
  var nav = document.getElementById('siteNav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  /* ---------- flash auto-dismiss ---------- */
  document.querySelectorAll('.flash').forEach(function (el) {
    setTimeout(function () {
      el.style.transition = 'opacity .4s ease';
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 400);
    }, 5500);
  });

  /* ---------- scroll reveal ---------- */
  var revealEls = document.querySelectorAll(
    '.section, .featured, .row-item, .game-card, .team-card, .wl-item, .feature-cell, .stage-grid > *, .game-body-grid > *'
  );
  if ('IntersectionObserver' in window && revealEls.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -50px 0px' });

    revealEls.forEach(function (el, i) {
      el.classList.add('reveal-pending');
      el.style.transitionDelay = (i % 3) * 70 + 'ms';
      io.observe(el);
    });
  }

  /* ---------- game media gallery ---------- */
  var stage = document.getElementById('mediaStage');
  var thumbs = document.getElementById('mediaThumbs');
  if (stage && thumbs) {
    thumbs.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;

      var type = btn.getAttribute('data-type');
      var mode = btn.getAttribute('data-mode');
      var src = btn.getAttribute('data-src');
      var poster = btn.getAttribute('data-poster');

      thumbs.querySelectorAll('button').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');

      if (type === 'video' && mode === 'video') {
        stage.innerHTML =
          '<video src="' + src + '" controls autoplay preload="metadata"' +
          (poster ? ' poster="' + poster + '"' : '') + '></video>';
      } else if (type === 'video') {
        stage.innerHTML =
          '<iframe src="' + src + '" title="Video" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen referrerpolicy="no-referrer"></iframe>';
      } else {
        stage.innerHTML = '<img src="' + src + '" alt="Game artwork" referrerpolicy="no-referrer" />';
      }
    });
  }
});

/* ---------------------------------------------------------------
   Interactive hero — a light constellation field that leans toward
   the pointer. Deliberately cheap: capped particle count, paused
   when off-screen, and skipped entirely for reduced-motion users.
   --------------------------------------------------------------- */
(function () {
  var canvas = document.getElementById('heroCanvas');
  if (!canvas) return;

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return;

  var ctx = canvas.getContext('2d');
  var dots = [];
  var w = 0, h = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
  var pointer = { x: -9999, y: -9999 };
  var running = true;
  var raf = null;

  function resize() {
    var rect = canvas.getBoundingClientRect();
    w = rect.width; h = rect.height;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Scale the count to the area, but never enough to cost real frames.
    var target = Math.min(90, Math.max(28, Math.round((w * h) / 16000)));
    dots = [];
    for (var i = 0; i < target; i++) {
      dots.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.22,
        vy: (Math.random() - 0.5) * 0.22,
        r: Math.random() * 1.6 + 0.7,
      });
    }
  }

  function step() {
    if (!running) { raf = null; return; }
    ctx.clearRect(0, 0, w, h);

    for (var i = 0; i < dots.length; i++) {
      var d = dots[i];
      d.x += d.vx; d.y += d.vy;

      if (d.x < -20) d.x = w + 20; else if (d.x > w + 20) d.x = -20;
      if (d.y < -20) d.y = h + 20; else if (d.y > h + 20) d.y = -20;

      // gentle pull toward the pointer
      var pdx = pointer.x - d.x, pdy = pointer.y - d.y;
      var pd2 = pdx * pdx + pdy * pdy;
      if (pd2 < 26000 && pd2 > 1) {
        var pull = 0.00016 * (26000 - pd2) / 26000;
        d.vx += pdx * pull; d.vy += pdy * pull;
      }
      // keep speeds sane
      d.vx = Math.max(-0.7, Math.min(0.7, d.vx * 0.995));
      d.vy = Math.max(-0.7, Math.min(0.7, d.vy * 0.995));

      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(180,242,48,0.5)';
      ctx.fill();
    }

    // link nearby dots
    for (var a = 0; a < dots.length; a++) {
      for (var b = a + 1; b < dots.length; b++) {
        var dx = dots[a].x - dots[b].x, dy = dots[a].y - dots[b].y;
        var dist2 = dx * dx + dy * dy;
        if (dist2 < 12000) {
          ctx.beginPath();
          ctx.moveTo(dots[a].x, dots[a].y);
          ctx.lineTo(dots[b].x, dots[b].y);
          ctx.strokeStyle = 'rgba(180,242,48,' + (0.16 * (1 - dist2 / 12000)).toFixed(3) + ')';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }

    raf = requestAnimationFrame(step);
  }

  function start() { if (!raf) { running = true; raf = requestAnimationFrame(step); } }
  function stop() { running = false; }

  canvas.addEventListener('pointermove', function (e) {
    var rect = canvas.getBoundingClientRect();
    pointer.x = e.clientX - rect.left;
    pointer.y = e.clientY - rect.top;
  });
  canvas.addEventListener('pointerleave', function () { pointer.x = pointer.y = -9999; });

  window.addEventListener('resize', resize);

  // Don't burn cycles animating a hero nobody is looking at.
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { en.isIntersecting ? start() : stop(); });
    }, { threshold: 0.02 }).observe(canvas);
  } else {
    start();
  }
  document.addEventListener('visibilitychange', function () {
    document.hidden ? stop() : start();
  });

  resize();
  start();
})();

/* Hero title: split into characters once so CSS can stagger them in. */
(function () {
  var title = document.getElementById('heroTitle');
  if (!title) return;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { title.classList.add('is-in'); return; }

  var lines = title.querySelectorAll('.hv-line');
  var index = 0;
  lines.forEach(function (line) {
    var text = line.textContent;
    line.textContent = '';
    for (var i = 0; i < text.length; i++) {
      var span = document.createElement('span');
      span.className = 'hv-ch';
      span.textContent = text[i] === ' ' ? ' ' : text[i];
      span.style.animationDelay = (index * 32) + 'ms';
      line.appendChild(span);
      index++;
    }
  });
  requestAnimationFrame(function () { title.classList.add('is-in'); });
})();

/* ---------------------------------------------------------------
   Like / dislike without a page reload. The forms work fine on
   their own if JS is off — this just makes them feel instant.
   --------------------------------------------------------------- */
(function () {
  var groups = document.querySelectorAll('.reactions');
  if (!groups.length) return;

  groups.forEach(function (group) {
    var forms = group.querySelectorAll('form');

    forms.forEach(function (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();

        var btn = form.querySelector('button');
        if (btn.disabled) return;
        btn.disabled = true;

        fetch(form.action, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: new URLSearchParams(new FormData(form)).toString(),
          credentials: 'same-origin',
        })
          .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
          .then(function (data) {
            var all = group.querySelectorAll('.react-btn');
            var up = all[0], down = all[1];
            if (up) {
              up.querySelector('span').textContent = data.likes;
              up.classList.toggle('is-on', data.myVote === 1);
            }
            if (down) {
              down.querySelector('span').textContent = data.dislikes;
              down.classList.toggle('is-on', data.myVote === -1);
            }
          })
          .catch(function () {
            // Something went wrong — fall back to a normal submit so the click
            // still counts rather than silently doing nothing.
            form.submit();
          })
          .then(function () { btn.disabled = false; });
      });
    });
  });
})();
