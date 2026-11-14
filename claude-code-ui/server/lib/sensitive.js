/*
 * Mode Confidentiel — les passages sensibles d'un message (1.5.9) : ce qui touche
 * au RGPD (santé, RH, données particulières, identifiants, adresses privées) ou à
 * la confidentialité de l'entreprise (montants, marges, stratégie, incidents).
 * Des règles, sur Home Assistant : elles reconnaissent des mots, pas le sens d'une
 * phrase qui n'en contient aucun. L'utilisateur choisit pour chaque passage
 * (mention neutre, réécriture, ou tel quel) ; rien ne part avant (confidential.js).
 */

export const CATEGORIES = {
  sante: { label: 'santé', mention: '[information de santé masquée]' },
  rh: { label: 'RH / personnel', mention: '[information RH masquée]' },
  particulier: { label: 'donnée particulière (RGPD art. 9-10)', mention: '[donnée personnelle sensible masquée]' },
  identite: { label: 'identifiant personnel', mention: '[donnée personnelle masquée]' },
  adresse: { label: 'adresse', mention: '[adresse masquée]' },
  entreprise: { label: 'confidentiel entreprise', mention: '[information confidentielle masquée]' },
  montant: { label: 'montant', mention: '[montant masqué]' },
  securite: { label: 'sécurité', mention: '[information de sécurité masquée]' },
};

// FR / EN / NL — racines, insensibles à la casse
const RULES = [
  ['sante', /\b(?:malad\w*|médic\w*|medic\w*|médecin\w*|hospitalis\w*|diagnosti\w*|burn-?out|dépression|depression|handicap\w*|enceinte|grossesse|pregnan\w*|zwanger\w*|congé (?:de )?maladie|arrêt (?:de )?maladie|certificat médical|incapacité de travail|accident (?:du|de) travail|thérapi\w*|therap\w*|chimio\w*|cancer|opér(?:é|ée|ation chirurgicale)|santé mentale|mental health|sick(?:ness)? leave|ziek\w*|arbeidsongeschikt\w*)\b/iu],
  ['rh', /\b(?:salaire\w*|rémunération\w*|salary|salaries|wage\w*|loon\b|lonen|brut annuel|net mensuel|augmentation de salaire|pay rise|raise\b|prime\w* individuelle|évaluation annuelle|entretien (?:annuel|d'évaluation)|appraisal|performance review|evaluatiegesprek|sanction\w*|avertissement\w*|disciplin\w*|licenci\w*|dismiss\w*|fired\b|layoff\w*|ontslag\w*|démission\w*|resign\w*|préavis|rupture conventionnelle|faute grave|C4\b|absentéisme|absenteeism)\b/iu],
  ['particulier', /\b(?:religi\w*|musulman\w*|chrétien\w*|juif\b|juive\w*|catholique\w*|syndica\w*|vakbond\w*|union member\w*|origine ethnique|ethnic\w*|racial\w*|orientation sexuelle|sexual orientation|homosexu\w*|gay\b|lesbienne|transgen\w*|opinion\w* politique\w*|political opinion\w*|parti politique|casier judiciaire|criminal record|condamn\w*|strafblad|biométri\w*|biometric\w*|génétique|genetic\w*)\b/iu],
  ['identite', /\b(?:date de naissance|né(?:e)? le \d|born on|geboortedatum|registre national|numéro national|rijksregister\w*|national (?:id|register)|carte d'identité|identity card|identiteitskaart|passeport|passport|numéro de sécurité sociale|social security number|permis de conduire|driving licen[cs]e)\b|\b\d{2}[.\s]?\d{2}[.\s]?\d{2}[-\s]\d{3}[.\s]?\d{2}\b/iu],
  ['adresse', /\b(?:domicilié\w*|habite au|vit au|lives at|woont (?:in|op)|adresse (?:privée|personnelle|du domicile)|home address|thuisadres)\b|(?<![\p{L}\p{N}_./-])[1-9]\d{3}\s+\p{Lu}\p{Ll}[\p{L}'’-]*(?![\p{L}:])|\b(?:rue|avenue|chaussée|boulevard|place|quai|chemin|allée)\s+[^,;\n]{2,40}|\b\p{L}+(?:straat|laan|steenweg|plein|lei|dreef|kaai)\b(?:\s+\d+\w?)?/iu],
  ['entreprise', /\b(?:confidentiel\w*|confidential\w*|vertrouwelijk\w*|NDA\b|secret\w* (?:des affaires|commercial|d'affaires)|trade secret\w*|stratégi\w*|strategy|strategic|strategie\w*|rachat|acquisition\w*|fusion\w*|merger\w*|overname\w*|restructur\w*|réorganisation|plan social|marge\w*|margin\w*|prix de revient|cost price|remise\w*|rabais|discount\w*|korting\w*|chiffre d'affaires|turnover|omzet|appel d'offres? (?:en cours|concurrent)|offre concurrente|competitor'?s? (?:price|offer))\b/iu],
  ['montant', /(?:€\s?\d[\d .,]*|\b\d[\d .,]*\s?(?:€|eur\b|euros?\b|k€|m€|keur\b|meur\b))/iu],
  ['securite', /\b(?:mot de passe|password|wachtwoord|identifiants? de connexion|login credentials|clé api|api key|token\b|cyber-?attaque\w*|cyber ?attack\w*|ransomware|rançongiciel|phishing|hameçonnage|fuite de données|data breach|datalek|incident de sécurité|security incident|vulnérabilité\w*|vulnerabilit\w*|faille de sécurité)\b/iu],
];

/** Sentences (or lines) with their offsets in `text`. */
function sentences(text) {
  const out = [];
  const re = /[^.!?\n]+(?:[.!?]+|\n|$)/g;
  for (const m of String(text).matchAll(re)) {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const body = raw.trim();
    if (body.length < 3) continue;
    out.push({ start: m.index + lead, end: m.index + lead + body.length, text: body });
  }
  return out;
}

/** → [{ start, end, text, cats: ['sante', …], label, mention }] — one entry per sensitive sentence */
export function sensitivePassages(text) {
  const out = [];
  for (const s of sentences(text)) {
    const cats = RULES.filter(([, re]) => re.test(s.text)).map(([c]) => c);
    if (!cats.length) continue;
    const first = CATEGORIES[cats[0]];
    out.push({ ...s, cats, label: cats.map((c) => CATEGORIES[c].label).join(', '), mention: first.mention });
  }
  return out;
}
