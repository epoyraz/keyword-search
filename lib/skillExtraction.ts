// Skill extraction from CV text — a self-contained dictionary/keyword matcher
// (no NLP model, no external API), ported from the cv-skill-extractor project
// (github.com/epoyraz/cv-skill-extractor). Keeps this app's "fully local, no
// external API" promise: the dropped PDF is read and matched entirely in the
// browser.
//
// extractSkills(text) returns scored skill tags: canonical catalog hits plus
// free-form entries pulled from a CV's "Skills"/"Technologies" sections.

export type SkillTag = {
  name: string;
  category: string;
  score: number;
};

type SkillEntry = {
  name: string;
  category: string;
  aliases?: string[];
};

const SKILL_CATALOG: SkillEntry[] = [
  { name: "JavaScript", category: "Programming", aliases: ["js", "ecmascript"] },
  { name: "TypeScript", category: "Programming", aliases: ["ts"] },
  { name: "Python", category: "Programming" },
  { name: "Java", category: "Programming" },
  { name: "C#", category: "Programming", aliases: ["c sharp", "csharp"] },
  { name: "C++", category: "Programming", aliases: ["cpp"] },
  { name: "C", category: "Programming" },
  { name: "Go", category: "Programming", aliases: ["golang"] },
  { name: "Rust", category: "Programming" },
  { name: "PHP", category: "Programming" },
  { name: "Ruby", category: "Programming" },
  { name: "Swift", category: "Programming" },
  { name: "Kotlin", category: "Programming" },
  { name: "Dart", category: "Programming" },
  { name: "Scala", category: "Programming" },
  { name: "R", category: "Programming" },
  { name: "SQL", category: "Data" },
  { name: "HTML", category: "Frontend" },
  { name: "CSS", category: "Frontend" },
  { name: "Sass", category: "Frontend", aliases: ["scss"] },
  { name: "Tailwind CSS", category: "Frontend", aliases: ["tailwind"] },
  { name: "React", category: "Frontend", aliases: ["react.js", "reactjs"] },
  { name: "Next.js", category: "Frontend", aliases: ["nextjs", "next js"] },
  { name: "Vue", category: "Frontend", aliases: ["vue.js", "vuejs"] },
  { name: "Nuxt", category: "Frontend", aliases: ["nuxt.js", "nuxtjs"] },
  { name: "Angular", category: "Frontend" },
  { name: "Svelte", category: "Frontend" },
  { name: "Redux", category: "Frontend" },
  { name: "Zustand", category: "Frontend" },
  { name: "GraphQL", category: "Backend" },
  { name: "REST APIs", category: "Backend", aliases: ["rest api", "restful"] },
  { name: "Node.js", category: "Backend", aliases: ["nodejs", "node js"] },
  { name: "Express", category: "Backend", aliases: ["express.js", "expressjs"] },
  { name: "NestJS", category: "Backend", aliases: ["nest.js", "nest js"] },
  { name: "Django", category: "Backend" },
  { name: "Flask", category: "Backend" },
  { name: "FastAPI", category: "Backend" },
  { name: "Spring Boot", category: "Backend", aliases: ["spring"] },
  { name: ".NET", category: "Backend", aliases: ["dotnet", "asp.net"] },
  { name: "Laravel", category: "Backend" },
  { name: "PostgreSQL", category: "Data", aliases: ["postgres"] },
  { name: "MySQL", category: "Data" },
  { name: "SQLite", category: "Data" },
  { name: "MongoDB", category: "Data", aliases: ["mongo"] },
  { name: "Redis", category: "Data" },
  { name: "Elasticsearch", category: "Data", aliases: ["elastic search"] },
  { name: "Snowflake", category: "Data" },
  { name: "BigQuery", category: "Data" },
  { name: "Databricks", category: "Data" },
  { name: "Pandas", category: "Data" },
  { name: "NumPy", category: "Data", aliases: ["numpy"] },
  { name: "TensorFlow", category: "AI" },
  { name: "PyTorch", category: "AI", aliases: ["pytorch"] },
  { name: "scikit-learn", category: "AI", aliases: ["sklearn", "scikit learn"] },
  { name: "Machine Learning", category: "AI", aliases: ["ml"] },
  { name: "Deep Learning", category: "AI" },
  { name: "NLP", category: "AI", aliases: ["natural language processing"] },
  { name: "LLMs", category: "AI", aliases: ["llm", "large language models"] },
  { name: "Computer Vision", category: "AI" },
  { name: "AWS", category: "Cloud", aliases: ["amazon web services"] },
  { name: "Azure", category: "Cloud", aliases: ["microsoft azure"] },
  { name: "Google Cloud", category: "Cloud", aliases: ["gcp", "google cloud platform"] },
  { name: "Docker", category: "DevOps" },
  { name: "Kubernetes", category: "DevOps", aliases: ["k8s"] },
  { name: "Terraform", category: "DevOps" },
  { name: "Ansible", category: "DevOps" },
  { name: "GitHub Actions", category: "DevOps" },
  { name: "GitLab CI", category: "DevOps" },
  { name: "Jenkins", category: "DevOps" },
  { name: "CI/CD", category: "DevOps", aliases: ["ci cd", "continuous integration"] },
  { name: "Linux", category: "Systems" },
  { name: "Bash", category: "Systems", aliases: ["shell scripting"] },
  { name: "PowerShell", category: "Systems" },
  { name: "Git", category: "Tools" },
  { name: "Figma", category: "Design" },
  { name: "Adobe XD", category: "Design" },
  { name: "Photoshop", category: "Design" },
  { name: "Illustrator", category: "Design" },
  { name: "UI Design", category: "Design" },
  { name: "UX Design", category: "Design" },
  { name: "Product Management", category: "Product" },
  { name: "Roadmapping", category: "Product" },
  { name: "User Research", category: "Product" },
  { name: "A/B Testing", category: "Product", aliases: ["ab testing", "a b testing"] },
  { name: "Analytics", category: "Product" },
  { name: "Agile", category: "Process" },
  { name: "Scrum", category: "Process" },
  { name: "Kanban", category: "Process" },
  { name: "Jira", category: "Tools" },
  { name: "Notion", category: "Tools" },
  { name: "Excel", category: "Business", aliases: ["microsoft excel"] },
  { name: "Power BI", category: "Business", aliases: ["powerbi"] },
  { name: "Tableau", category: "Business" },
  { name: "Looker", category: "Business" },
  { name: "Salesforce", category: "Business" },
  { name: "HubSpot", category: "Business" },
  { name: "SEO", category: "Marketing" },
  { name: "SEM", category: "Marketing" },
  { name: "CRM", category: "Business" },
  { name: "Project Management", category: "Business" },
  { name: "Stakeholder Management", category: "Business" },
  { name: "Communication", category: "Business" },
  { name: "Leadership", category: "Business" },
];

const SECTION_HEADINGS = [
  "skills",
  "technical skills",
  "core skills",
  "core competencies",
  "competencies",
  "technologies",
  "tools",
  "tech stack",
  "programming languages",
  "languages and frameworks",
];

const STOP_WORDS = new Set([
  "and",
  "or",
  "with",
  "for",
  "from",
  "skills",
  "technical",
  "experience",
  "education",
  "summary",
  "profile",
  "projects",
  "work",
  "employment",
  "contact",
  "email",
  "phone",
  "linkedin",
  "github",
]);

const aliasToEntry = new Map<string, SkillEntry>();

for (const entry of SKILL_CATALOG) {
  for (const alias of [entry.name, ...(entry.aliases ?? [])]) {
    aliasToEntry.set(normalize(alias), entry);
  }
}

export function extractSkills(rawText: string): SkillTag[] {
  const text = normalize(rawText);
  const sectionText = normalize(extractSkillSections(rawText));
  const found = new Map<string, SkillTag>();

  for (const entry of SKILL_CATALOG) {
    let score = 0;

    for (const alias of [entry.name, ...(entry.aliases ?? [])]) {
      score += countMatches(text, alias);
      score += countMatches(sectionText, alias) * 2;
    }

    if (score > 0) {
      found.set(entry.name, { name: entry.name, category: entry.category, score });
    }
  }

  for (const candidate of extractSectionCandidates(rawText)) {
    const mapped = aliasToEntry.get(normalize(candidate));

    if (mapped) {
      const existing = found.get(mapped.name);
      found.set(mapped.name, {
        name: mapped.name,
        category: mapped.category,
        score: (existing?.score ?? 0) + 3,
      });
      continue;
    }

    const cleaned = cleanCandidate(candidate);

    if (cleaned && !found.has(cleaned)) {
      found.set(cleaned, { name: cleaned, category: "Mentioned skills", score: 2 });
    }
  }

  return [...found.values()]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 40);
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\S\r\n]+/g, " ")
    .trim();
}

function countMatches(text: string, alias: string) {
  const normalizedAlias = escapeRegExp(normalize(alias));
  const matcher = new RegExp(`(^|[^a-z0-9+#.])${normalizedAlias}($|[^a-z0-9+#.])`, "g");
  return text.match(matcher)?.length ?? 0;
}

function extractSkillSections(rawText: string) {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const sections: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = normalize(lines[index].replace(/[:|]/g, " "));

    if (!SECTION_HEADINGS.some((heading) => line === heading || line.startsWith(`${heading} `))) {
      continue;
    }

    sections.push(lines[index]);

    for (let offset = 1; offset <= 6 && lines[index + offset]; offset += 1) {
      const nextLine = normalize(lines[index + offset].replace(/[:|]/g, " "));
      const looksLikeNewHeading =
        nextLine.length < 35 &&
        /^(experience|education|projects|certifications|languages|summary|profile|employment|work history)/.test(
          nextLine,
        );

      if (looksLikeNewHeading) {
        break;
      }

      sections.push(lines[index + offset]);
    }
  }

  return sections.join("\n");
}

function extractSectionCandidates(rawText: string) {
  const sectionText = extractSkillSections(rawText);

  return sectionText
    .split(/[,;•|·\n\t]/)
    .flatMap((part) => part.split(/\s{2,}/))
    .map(cleanCandidate)
    .filter((candidate): candidate is string => Boolean(candidate));
}

function cleanCandidate(candidate: string) {
  const cleaned = candidate
    .replace(/\([^)]*\)/g, "")
    .replace(/^[^a-zA-Z0-9.+#]+|[^a-zA-Z0-9.+#]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length < 2 || cleaned.length > 32) {
    return null;
  }

  const words = cleaned.split(" ");

  if (words.length > 4 || words.every((word) => STOP_WORDS.has(normalize(word)))) {
    return null;
  }

  if (!/[a-zA-Z]/.test(cleaned) || /^\d+$/.test(cleaned)) {
    return null;
  }

  const normalized = normalize(cleaned);

  if (STOP_WORDS.has(normalized) || normalized.includes("@") || normalized.startsWith("http")) {
    return null;
  }

  return titleCaseKnownAcronyms(cleaned);
}

function titleCaseKnownAcronyms(value: string) {
  const known = aliasToEntry.get(normalize(value));

  if (known) {
    return known.name;
  }

  if (value === value.toUpperCase() && value.length <= 5) {
    return value;
  }

  return value
    .split(" ")
    .map((word) => {
      if (word.length <= 3 && word === word.toUpperCase()) {
        return word;
      }

      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
