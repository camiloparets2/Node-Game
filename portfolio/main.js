// ---- Project data (sourced from github.com/camiloparets2) ----
const analyticsProjects = [
  {
    name: "DataVisTest",
    icon: "📈",
    lang: "R",
    color: "#198ce6",
    desc: "Exploratory data-visualization experiments in R — turning raw datasets into clear, decision-ready charts.",
    url: "https://github.com/camiloparets2/DataVisTest",
  },
  {
    name: "ggplus",
    icon: "📊",
    lang: "R",
    color: "#198ce6",
    desc: "Statistical graphics built on ggplot2, exploring layered grammar-of-graphics visualizations.",
    url: "https://github.com/camiloparets2/ggplus",
  },
  {
    name: "ai50",
    icon: "🧠",
    lang: "Python",
    color: "#3572A5",
    desc: "Harvard CS50's Introduction to Artificial Intelligence — search, knowledge, optimization, and machine-learning projects.",
    url: "https://github.com/camiloparets2/ai50",
  },
];

const devProjects = [
  {
    name: "AI Marketplace",
    icon: "🛒",
    lang: "TypeScript",
    color: "#2b7489",
    desc: "A full-stack AI marketplace application built with TypeScript — connecting AI services with users.",
    url: "https://github.com/camiloparets2/ai-marketplace",
  },
  {
    name: "Stickman Fight Bets",
    icon: "⚔️",
    lang: "TypeScript",
    color: "#2b7489",
    desc: "An interactive Reddit (Devvit) game where players bet on stickman fights, with a Redis-backed global leaderboard.",
    url: "https://github.com/camiloparets2/Node-Game",
  },
  {
    name: "Math Game",
    icon: "🔢",
    lang: "TypeScript",
    color: "#2b7489",
    desc: "A fast-paced math challenge game built on the Devvit platform — quick mental-math rounds for Reddit communities.",
    url: "https://github.com/camiloparets2/MathGame",
  },
];

function renderCards(list, mountId) {
  const mount = document.getElementById(mountId);
  if (!mount) return;
  mount.innerHTML = list
    .map(
      (p) => `
      <article class="pcard reveal">
        <div class="pcard-top">
          <div class="pcard-icon">${p.icon}</div>
          <span class="pcard-lang"><span class="lang-dot" style="background:${p.color}"></span>${p.lang}</span>
        </div>
        <h3>${p.name}</h3>
        <p>${p.desc}</p>
        <a class="pcard-link" href="${p.url}" target="_blank" rel="noopener">View on GitHub →</a>
      </article>`
    )
    .join("");
}

renderCards(analyticsProjects, "analyticsProjects");
renderCards(devProjects, "devProjects");

// ---- Reveal on scroll ----
const io = new IntersectionObserver(
  (entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        e.target.classList.add("in");
        io.unobserve(e.target);
      }
    });
  },
  { threshold: 0.12 }
);
document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

// ---- Animated stat counters ----
const counters = document.querySelectorAll(".stat-num");
const counterIO = new IntersectionObserver(
  (entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      const el = e.target;
      const target = parseFloat(el.dataset.target);
      const decimals = parseInt(el.dataset.decimals || "0", 10);
      const suffix = el.dataset.suffix || "";
      const duration = 1400;
      const start = performance.now();
      function tick(now) {
        const p = Math.min((now - start) / duration, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = (target * eased).toFixed(decimals) + suffix;
        if (p < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
      counterIO.unobserve(el);
    });
  },
  { threshold: 0.5 }
);
counters.forEach((c) => counterIO.observe(c));

// ---- Nav: scroll state + mobile toggle ----
const nav = document.getElementById("nav");
window.addEventListener("scroll", () => {
  nav.classList.toggle("scrolled", window.scrollY > 20);
});

const toggle = document.getElementById("navToggle");
const links = document.querySelector(".nav-links");
toggle?.addEventListener("click", () => links.classList.toggle("open"));
links?.querySelectorAll("a").forEach((a) =>
  a.addEventListener("click", () => links.classList.remove("open"))
);

// ---- Footer year ----
document.getElementById("year").textContent = new Date().getFullYear();
