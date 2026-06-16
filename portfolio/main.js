// ============================================================
//  Camilo Parets — portfolio interactions
// ============================================================
(function () {
  "use strict";
  const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fine = matchMedia("(hover: hover) and (pointer: fine)").matches;

  // ---- Project data (sourced from github.com/camiloparets2) ----
  const analyticsProjects = [
    { name: "DataVisTest", icon: "📈", lang: "R", color: "#198ce6",
      desc: "Exploratory data-visualization experiments in R — turning raw datasets into clear, decision-ready charts.",
      url: "https://github.com/camiloparets2/DataVisTest" },
    { name: "ggplus", icon: "📊", lang: "R", color: "#198ce6",
      desc: "Statistical graphics built on ggplot2, exploring layered grammar-of-graphics visualizations.",
      url: "https://github.com/camiloparets2/ggplus" },
    { name: "ai50", icon: "🧠", lang: "Python", color: "#3572A5",
      desc: "Harvard CS50's Introduction to Artificial Intelligence — search, knowledge, optimization, and machine-learning projects.",
      url: "https://github.com/camiloparets2/ai50" },
  ];
  const devProjects = [
    { name: "AI Marketplace", icon: "🛒", lang: "TypeScript", color: "#2b7489",
      desc: "A full-stack AI marketplace application built with TypeScript — connecting AI services with users.",
      url: "https://github.com/camiloparets2/ai-marketplace" },
    { name: "Stickman Fight Bets", icon: "⚔️", lang: "TypeScript", color: "#2b7489",
      desc: "An interactive Reddit (Devvit) game where players bet on stickman fights, with a Redis-backed global leaderboard.",
      url: "https://github.com/camiloparets2/Node-Game" },
    { name: "Math Game", icon: "🔢", lang: "TypeScript", color: "#2b7489",
      desc: "A fast-paced math challenge game built on the Devvit platform — quick mental-math rounds for Reddit communities.",
      url: "https://github.com/camiloparets2/MathGame" },
  ];

  function renderCards(list, mountId) {
    const mount = document.getElementById(mountId);
    if (!mount) return;
    list.forEach((p, i) => {
      const a = document.createElement("article");
      a.className = "pcard tilt reveal";
      a.setAttribute("data-reveal", "up");
      if (i) a.setAttribute("data-delay", String(Math.min(i, 5)));
      a.innerHTML = `
        <div class="pcard-top">
          <div class="pcard-icon">${p.icon}</div>
          <span class="pcard-lang"><span class="lang-dot" style="background:${p.color}"></span>${p.lang}</span>
        </div>
        <h3>${p.name}</h3>
        <p>${p.desc}</p>
        <a class="pcard-link" href="${p.url}" target="_blank" rel="noopener">View on GitHub →</a>`;
      // Make whole card clickable without breaking the inner link
      a.addEventListener("click", (e) => {
        if (e.target.closest("a")) return;
        window.open(p.url, "_blank", "noopener");
      });
      mount.appendChild(a);
    });
  }
  renderCards(analyticsProjects, "analyticsProjects");
  renderCards(devProjects, "devProjects");

  // ---- Reveal on scroll ----
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      });
    },
    { threshold: 0.14, rootMargin: "0px 0px -8% 0px" }
  );
  document.querySelectorAll(".reveal, .stagger").forEach((el) => io.observe(el));

  // ---- Animated stat counters ----
  const counterIO = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        const el = e.target;
        const target = parseFloat(el.dataset.target);
        const decimals = parseInt(el.dataset.decimals || "0", 10);
        const suffix = el.dataset.suffix || "";
        if (RM) { el.textContent = target.toFixed(decimals) + suffix; counterIO.unobserve(el); return; }
        const dur = 1500, start = performance.now();
        (function tick(now) {
          const p = Math.min((now - start) / dur, 1);
          const eased = 1 - Math.pow(1 - p, 3);
          el.textContent = (target * eased).toFixed(decimals) + suffix;
          if (p < 1) requestAnimationFrame(tick);
        })(start);
        counterIO.unobserve(el);
      });
    },
    { threshold: 0.5 }
  );
  document.querySelectorAll(".stat-num").forEach((c) => counterIO.observe(c));

  // ---- Nav: scroll state, hide-on-scroll-down, active link ----
  const nav = document.getElementById("nav");
  let lastY = 0;
  function onScroll() {
    const y = window.scrollY;
    nav.classList.toggle("scrolled", y > 24);
    if (y > 400 && y > lastY + 4) nav.classList.add("hidden");
    else if (y < lastY - 4 || y < 200) nav.classList.remove("hidden");
    lastY = y;
    const sp = document.getElementById("scrollProgress");
    const h = document.documentElement.scrollHeight - window.innerHeight;
    sp.style.width = (h > 0 ? (y / h) * 100 : 0) + "%";
  }
  window.addEventListener("scroll", onScroll, { passive: true });

  // active nav link via section observer
  const navLinks = [...document.querySelectorAll(".nav-links a[data-nav]")];
  const sectionFor = {};
  navLinks.forEach((a) => { const id = a.getAttribute("href").slice(1); const s = document.getElementById(id); if (s) sectionFor[id] = a; });
  const secIO = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          navLinks.forEach((l) => l.classList.remove("active"));
          if (sectionFor[e.target.id]) sectionFor[e.target.id].classList.add("active");
        }
      });
    },
    { rootMargin: "-45% 0px -50% 0px" }
  );
  Object.keys(sectionFor).forEach((id) => secIO.observe(document.getElementById(id)));

  // ---- Mobile menu ----
  const toggle = document.getElementById("navToggle");
  const links = document.getElementById("navLinks");
  toggle?.addEventListener("click", () => { links.classList.toggle("open"); toggle.classList.toggle("open"); });
  links?.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => { links.classList.remove("open"); toggle.classList.remove("open"); }));

  // ---- Rotating role text ----
  const rotator = document.getElementById("rotator");
  if (rotator && !RM) {
    const roles = ["Data Analyst", "Power BI Developer", "SQL Engineer", "Predictive Modeler", "Full-Stack Builder"];
    let i = 0;
    setInterval(() => {
      const cur = rotator.querySelector("span");
      const next = document.createElement("span");
      i = (i + 1) % roles.length;
      next.textContent = roles[i];
      next.classList.add("in");
      cur.classList.add("out");
      rotator.appendChild(next);
      setTimeout(() => cur.remove(), 500);
    }, 2400);
  }

  // ---- Cursor spotlight ----
  if (fine && !RM) {
    const sp = document.getElementById("spotlight");
    let tx = 0, ty = 0, cx = 0, cy = 0;
    window.addEventListener("mousemove", (e) => { tx = e.clientX; ty = e.clientY; sp.classList.add("on"); });
    document.addEventListener("mouseleave", () => sp.classList.remove("on"));
    (function loop() {
      cx += (tx - cx) * 0.16; cy += (ty - cy) * 0.16;
      sp.style.transform = `translate(${cx}px, ${cy}px) translate(-50%, -50%)`;
      requestAnimationFrame(loop);
    })();
  }

  // ---- Magnetic buttons ----
  if (fine && !RM) {
    document.querySelectorAll("[data-magnetic]").forEach((el) => {
      el.addEventListener("mousemove", (e) => {
        const r = el.getBoundingClientRect();
        const mx = e.clientX - r.left - r.width / 2;
        const my = e.clientY - r.top - r.height / 2;
        el.style.transform = `translate(${mx * 0.25}px, ${my * 0.35}px)`;
      });
      el.addEventListener("mouseleave", () => { el.style.transform = ""; });
    });
  }

  // ---- 3D tilt + glow-follow on cards ----
  if (fine && !RM) {
    document.querySelectorAll(".tilt").forEach((card) => {
      card.addEventListener("mousemove", (e) => {
        const r = card.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width;
        const py = (e.clientY - r.top) / r.height;
        card.style.setProperty("--mx", px * 100 + "%");
        card.style.setProperty("--my", py * 100 + "%");
        const rx = (py - 0.5) * -5, ry = (px - 0.5) * 6;
        card.style.transform = `perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg) translateY(-4px)`;
      });
      card.addEventListener("mouseleave", () => { card.style.transform = ""; });
    });
  }

  // ---- Hero particle network ----
  const canvas = document.getElementById("heroCanvas");
  if (canvas && !RM) {
    const ctx = canvas.getContext("2d");
    let w, h, pts, raf, mouse = { x: -9999, y: -9999 };
    const DPR = Math.min(devicePixelRatio || 1, 2);
    function resize() {
      const hero = canvas.parentElement;
      w = hero.clientWidth; h = hero.clientHeight;
      canvas.width = w * DPR; canvas.height = h * DPR;
      canvas.style.width = w + "px"; canvas.style.height = h + "px";
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      const count = Math.min(78, Math.round((w * h) / 16000));
      pts = Array.from({ length: count }, () => ({
        x: Math.random() * w, y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.35, vy: (Math.random() - 0.5) * 0.35,
      }));
    }
    function draw() {
      ctx.clearRect(0, 0, w, h);
      for (const p of pts) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > w) p.vx *= -1;
        if (p.y < 0 || p.y > h) p.vy *= -1;
        const dmx = p.x - mouse.x, dmy = p.y - mouse.y;
        if (dmx * dmx + dmy * dmy < 16000) { p.x += dmx * 0.012; p.y += dmy * 0.012; }
      }
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const a = pts[i], b = pts[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < 18000) {
            const o = (1 - d2 / 18000) * 0.5;
            ctx.strokeStyle = `rgba(91,140,255,${o})`;
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          }
        }
      }
      for (const p of pts) {
        ctx.fillStyle = "rgba(56,225,196,.85)";
        ctx.beginPath(); ctx.arc(p.x, p.y, 1.7, 0, 6.283); ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    }
    const hero = canvas.parentElement;
    hero.addEventListener("mousemove", (e) => { const r = hero.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top; });
    hero.addEventListener("mouseleave", () => { mouse.x = -9999; mouse.y = -9999; });
    window.addEventListener("resize", resize);
    resize(); draw();
    // pause when hero off-screen
    new IntersectionObserver((en) => {
      en.forEach((e) => { if (e.isIntersecting) { if (!raf) draw(); } else { cancelAnimationFrame(raf); raf = null; } });
    }).observe(hero);
  }

  // ---- Footer year ----
  document.getElementById("year").textContent = new Date().getFullYear();

  // ---- Preloader off ----
  window.addEventListener("load", () => {
    setTimeout(() => document.getElementById("preloader")?.classList.add("done"), 500);
  });
  // safety: never let preloader trap the page
  setTimeout(() => document.getElementById("preloader")?.classList.add("done"), 2600);
})();
