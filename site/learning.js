(() => {
  "use strict";

  const STORAGE_KEY = "hardlabel.learning.done";

  function readDone() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return new Set(Array.isArray(value) ? value : []);
    } catch (_error) {
      return new Set();
    }
  }

  function saveDone(done) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...done]));
    } catch (_error) {
      // Private browsing: progress simply stays in memory.
    }
  }

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function updateProgress(total, done) {
    document.getElementById("progress-text").textContent = `Progression : ${done.size} / ${total} leçons validées`;
    const bar = document.getElementById("progress-bar");
    bar.max = Math.max(total, 1);
    bar.value = done.size;
  }

  function renderQuiz(lesson, done, total, title) {
    const box = el("div", undefined, "quiz");
    box.append(el("p", `📝 ${lesson.quiz.question}`));
    const feedback = el("p", "", "feedback");
    lesson.quiz.options.forEach((option, index) => {
      const button = el("button", `${String.fromCharCode(65 + index)}. ${option}`, "outline");
      button.type = "button";
      button.addEventListener("click", () => {
        const correct = index === lesson.quiz.answer;
        feedback.textContent = `${correct ? "✅ Bravo ! " : `❌ Réponse attendue : ${lesson.quiz.options[lesson.quiz.answer]}. `}${lesson.quiz.explain || ""}`;
        if (correct && !done.has(lesson.id)) {
          done.add(lesson.id);
          saveDone(done);
          title.append(el("span", "✓ validée", "done-badge"));
          updateProgress(total, done);
        }
      });
      box.append(button);
    });
    box.append(feedback);
    return box;
  }

  async function load() {
    const target = document.getElementById("curriculum");
    let data;
    try {
      const response = await fetch("data/learning.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      data = await response.json();
    } catch (_error) {
      target.replaceChildren(el("p", "Parcours indisponible hors ligne. Réessaie plus tard."));
      return;
    }
    const done = readDone();
    const modules = Array.isArray(data.modules) ? data.modules : [];
    const total = modules.reduce((sum, module) => sum + (module.lessons || []).length, 0);
    const toc = document.getElementById("toc");
    target.replaceChildren();
    modules.forEach((module) => {
      const link = el("a", `${module.emoji || ""} ${module.title}`);
      link.href = `#${module.id}`;
      toc.append(link);
      const section = el("section", undefined, "module-card");
      section.id = module.id;
      section.append(el("h3", `${module.emoji || ""} ${module.title}`), el("p", module.intro || ""));
      (module.lessons || []).forEach((lesson, index) => {
        const article = el("article", undefined, "lesson");
        article.id = lesson.id;
        const title = el("h4", `${index + 1}. ${lesson.title}`);
        if (done.has(lesson.id)) title.append(el("span", "✓ validée", "done-badge"));
        article.append(title, el("pre", lesson.content || ""));
        if (lesson.example) article.append(el("p", `💡 ${lesson.example}`, "example"));
        if (Array.isArray(lesson.terms) && lesson.terms.length) {
          const terms = el("p", undefined, "terms");
          terms.append(el("strong", "🇬🇧 Mots à retenir : "));
          terms.append(document.createTextNode(lesson.terms.map(([en, fr]) => `${en} = ${fr}`).join(" · ")));
          article.append(terms);
        }
        if (lesson.quiz) article.append(renderQuiz(lesson, done, total, title));
        section.append(article);
      });
      target.append(section);
    });
    updateProgress(total, done);
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }

  void load();
})();
