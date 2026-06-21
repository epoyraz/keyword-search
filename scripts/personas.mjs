// Synthetic test personas for the job matcher — 3 per profession, across the
// non-tech sectors that dominate the Swiss corpus (Pflege, Bau, Ärzte,
// Detailhandel, Sachbearbeiter, Elektrotechnik). Each has a short CV blurb and
// the skills a user would tag. Skills are realistic Swiss-German domain terms so
// they exercise the real index. No real people — safe to commit.
//
// Used by scripts/personas-test.mjs. Short Swiss qualifications like "HF"/"HR"
// (1–2 letters) are intentionally included to exercise the refine-only path.

export const personas = [
  // ── Pflege ────────────────────────────────────────────────────────────────
  {
    profession: "Pflege",
    name: "Anna Keller",
    role: "Pflegefachfrau HF, Akutspital",
    skills: ["Pflegefachfrau", "Akutpflege", "Grundpflege", "Medikamente", "Patientenbetreuung", "Pflegedokumentation", "HF"],
    cv: "Diplomierte Pflegefachfrau HF mit 6 Jahren Erfahrung in der Akutpflege. Grundpflege, Medikamentenmanagement, Patientenbetreuung und Pflegedokumentation auf einer chirurgischen Bettenstation.",
  },
  {
    profession: "Pflege",
    name: "Marija Petrović",
    role: "Fachfrau Gesundheit EFZ, Langzeitpflege",
    skills: ["Fachfrau Gesundheit", "Betreuung", "Grundpflege", "Pflegeheim", "Senioren", "Hygiene", "EFZ"],
    cv: "Fachfrau Gesundheit EFZ in der Langzeitpflege. Betreuung und Grundpflege von Seniorinnen und Senioren im Pflegeheim, Hygiene, Mobilisation und Alltagsgestaltung.",
  },
  {
    profession: "Pflege",
    name: "Sandra Bühler",
    role: "Pflegefachfrau Intensivpflege (IPS)",
    skills: ["Intensivpflege", "Beatmung", "Notfall", "Anästhesiepflege", "Monitoring", "IPS"],
    cv: "Pflegefachfrau mit Fachweiterbildung Intensivpflege (IPS). Beatmung, hämodynamisches Monitoring, Notfallmanagement und Anästhesiepflege im interdisziplinären Team.",
  },

  // ── Bau ───────────────────────────────────────────────────────────────────
  {
    profession: "Bau",
    name: "Luca Ferrari",
    role: "Maurer EFZ",
    skills: ["Maurer", "Hochbau", "Schalung", "Beton", "Mauerwerk", "Baustelle", "EFZ"],
    cv: "Maurer EFZ mit langjähriger Erfahrung im Hochbau. Schalungsarbeiten, Beton, Mauerwerk und Umbauten; selbstständiges Arbeiten auf der Baustelle.",
  },
  {
    profession: "Bau",
    name: "Thomas Widmer",
    role: "Bauführer Hochbau",
    skills: ["Bauführer", "Bauleitung", "Hochbau", "Terminplanung", "Submission", "Devis"],
    cv: "Bauführer Hochbau mit Verantwortung für Bauleitung, Terminplanung, Devis und Submissionen. Führung von Baustellen und Subunternehmern.",
  },
  {
    profession: "Bau",
    name: "Driton Krasniqi",
    role: "Polier Tiefbau",
    skills: ["Polier", "Tiefbau", "Strassenbau", "Kanalisation", "Baumaschinen"],
    cv: "Polier im Tiefbau, spezialisiert auf Strassenbau und Kanalisation. Einsatzplanung von Baumaschinen und Führung der Equipe vor Ort.",
  },

  // ── Ärzte ─────────────────────────────────────────────────────────────────
  {
    profession: "Ärzte",
    name: "Dr. Julia Meier",
    role: "Assistenzärztin Innere Medizin",
    skills: ["Assistenzarzt", "Innere Medizin", "Notfall", "Diagnostik", "Stationsarzt"],
    cv: "Assistenzärztin Innere Medizin mit Erfahrung in Notfall und Diagnostik. Stationsärztliche Betreuung und interdisziplinäre Zusammenarbeit.",
  },
  {
    profession: "Ärzte",
    name: "Dr. Marco Rossi",
    role: "Facharzt Chirurgie FMH",
    skills: ["Facharzt", "Chirurgie", "FMH", "Viszeralchirurgie", "Operationen"],
    cv: "Facharzt Chirurgie FMH mit Schwerpunkt Viszeralchirurgie. Selbstständige Durchführung von Operationen und ambulante Sprechstunde.",
  },
  {
    profession: "Ärzte",
    name: "Dr. Claire Dubois",
    role: "Oberärztin Anästhesie",
    skills: ["Oberarzt", "Anästhesie", "Intensivmedizin", "Narkose", "Schmerztherapie"],
    cv: "Oberärztin Anästhesie mit Erfahrung in Intensivmedizin, Narkose und Schmerztherapie. Supervision von Assistenzärzten.",
  },

  // ── Detailhandel ──────────────────────────────────────────────────────────
  {
    profession: "Detailhandel",
    name: "Elena Fischer",
    role: "Detailhandelsfachfrau",
    skills: ["Detailhandelsfachfrau", "Verkauf", "Kundenberatung", "Kasse", "Warenpräsentation"],
    cv: "Detailhandelsfachfrau mit Freude am Verkauf und an der Kundenberatung. Kassenführung, Warenpräsentation und Bewirtschaftung der Abteilung.",
  },
  {
    profession: "Detailhandel",
    name: "Kevin Schmid",
    role: "Filialleiter",
    skills: ["Filialleiter", "Verkauf", "Teamführung", "Umsatz", "Personalplanung"],
    cv: "Filialleiter im Detailhandel mit Verantwortung für Umsatz, Teamführung und Personalplanung. Coaching des Verkaufsteams und Erreichung der Filialziele.",
  },
  {
    profession: "Detailhandel",
    name: "Aylin Demir",
    role: "Detailhandelsassistentin EBA",
    skills: ["Detailhandelsassistent", "Verkauf", "Lager", "Regal", "Kundenkontakt", "EBA"],
    cv: "Detailhandelsassistentin EBA mit Erfahrung im Verkauf, in der Lagerbewirtschaftung und im direkten Kundenkontakt.",
  },

  // ── Sachbearbeiter ────────────────────────────────────────────────────────
  {
    profession: "Sachbearbeiter",
    name: "Petra Huber",
    role: "Sachbearbeiterin Buchhaltung",
    skills: ["Sachbearbeiter", "Buchhaltung", "Debitoren", "Kreditoren", "Excel", "Abacus"],
    cv: "Sachbearbeiterin Buchhaltung mit Erfahrung in Debitoren und Kreditoren. Sicherer Umgang mit Excel und Abacus, Mehrwertsteuerabrechnung und Mahnwesen.",
  },
  {
    profession: "Sachbearbeiter",
    name: "Daniel Brunner",
    role: "Sachbearbeiter HR",
    skills: ["Sachbearbeiter", "Personaladministration", "Lohnbuchhaltung", "Zeugnisse", "HR"],
    cv: "Sachbearbeiter HR mit Schwerpunkt Personaladministration und Lohnbuchhaltung. Erstellung von Arbeitszeugnissen und Ansprechperson für Mitarbeitende.",
  },
  {
    profession: "Sachbearbeiter",
    name: "Sofia Costa",
    role: "Kaufmännische Sachbearbeiterin",
    skills: ["Sachbearbeiter", "Administration", "Korrespondenz", "Auftragsabwicklung", "SAP"],
    cv: "Kaufmännische Sachbearbeiterin mit Erfahrung in Administration, Korrespondenz und Auftragsabwicklung. Anwenderin von SAP.",
  },

  // ── Elektrotechnik ────────────────────────────────────────────────────────
  {
    profession: "Elektrotechnik",
    name: "Reto Steiner",
    role: "Elektroinstallateur EFZ",
    skills: ["Elektroinstallateur", "Elektroinstallation", "Verkabelung", "Schaltschrank", "NIN"],
    cv: "Elektroinstallateur EFZ mit Erfahrung in Elektroinstallationen, Verkabelung und Schaltschrankbau. Arbeiten nach NIN, Mess- und Prüfprotokolle.",
  },
  {
    profession: "Elektrotechnik",
    name: "Nina Gerber",
    role: "Elektroplanerin",
    skills: ["Elektroplaner", "Elektroplanung", "CAD", "Installationsplanung", "Lichtplanung"],
    cv: "Elektroplanerin mit Erfahrung in Elektroplanung und Installationsplanung. CAD-Zeichnungen, Lichtplanung und Erstellung von Schemas.",
  },
  {
    profession: "Elektrotechnik",
    name: "Jonas Aebi",
    role: "Automatiker SPS",
    skills: ["Automatiker", "SPS", "Steuerung", "Schaltschrankbau", "Automation"],
    cv: "Automatiker mit Schwerpunkt SPS-Programmierung und Steuerungstechnik. Schaltschrankbau, Inbetriebnahme und Automation von Anlagen.",
  },
];
