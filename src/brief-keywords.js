/**
 * Deterministic keyword matching for the session brief (plan task A3; D-359):
 * a tokenizer with light suffix stemming and a BM25F-style scorer over a
 * small fielded index. No embeddings, no network, no model — the same inputs
 * always produce the same terms and scores.
 */

const STOPWORDS = new Set(
  (
    'a about above after again against all also am an and any are as at be because been before being below between both but by ' +
    'can cannot could did do does doing done down during each either etc even ever every few for from further had has have having ' +
    'he her here hers him his how however i if in into is it its itself just me more most much my neither no nor not now of off on ' +
    'once one only onto or other our ours out over own per same she should so some such than that the their theirs them then there ' +
    'these they this those though through thus to too under until up upon us very via was we were what whatever when where whether ' +
    'which while who whom whose why will with within without would yet you your yours'
  ).split(' '),
);

// Instruction framing that says what to do, not what the task is about.
// Dropped from query text only; indexed memory keeps every content word.
const QUERY_FRAMING = new Set(
  (
    'add answer anything change create edit everything afterward afterwards happen implement include including instead make ' +
    'modify need please rewrite something thing things walk want write'
  ).split(' '),
);

const IRREGULAR = new Map([
  ['paid', 'pay'],
  ['made', 'make'],
  ['built', 'build'],
  ['ran', 'run'],
  ['written', 'write'],
  ['wrote', 'write'],
  ['chosen', 'choose'],
  ['chose', 'choose'],
]);

// Ordered suffix rules: the first rule whose suffix matches (with at least
// `min` characters left) applies. A final `e` is dropped afterwards so
// "translate" and "translation" meet at "translat".
const SUFFIX_RULES = [
  ['ational', 'ate', 3],
  ['izations', 'ize', 3],
  ['ization', 'ize', 3],
  ['ations', 'ate', 3],
  ['ation', 'ate', 3],
  ['ements', '', 4],
  ['ement', '', 4],
  ['ments', '', 3],
  ['ment', '', 3],
  ['nesses', '', 3],
  ['ness', '', 3],
  ['ingly', '', 3],
  ['ings', '', 3],
  ['ing', '', 3],
  ['edly', '', 3],
  ['ies', 'y', 2],
  ['ied', 'y', 2],
  ['sses', 'ss', 2],
  ['xes', 'x', 2],
  ['ches', 'ch', 2],
  ['shes', 'sh', 2],
  ['ed', '', 3],
  ['ly', '', 4],
  ['s', '', 3],
];

// Common abbreviations meet their long forms after stemming, at index and
// query time alike: "organizations" and "org" both become "org".
const CANONICAL_STEMS = new Map([
  ['organiz', 'org'],
  ['repository', 'repo'],
  ['configurat', 'config'],
  ['databas', 'db'],
  ['environ', 'env'],
  ['documentat', 'doc'],
  ['authenticat', 'auth'],
]);

export function stemWord(word) {
  const stem = stemRaw(word);
  return CANONICAL_STEMS.get(stem) ?? stem;
}

function stemRaw(word) {
  const lower = word.toLowerCase();
  if (IRREGULAR.has(lower)) return IRREGULAR.get(lower);
  if (lower.length <= 3 || lower.endsWith('ss') || lower.endsWith('us') || lower.endsWith('is')) {
    return lower;
  }

  let stem = lower;
  for (const [suffix, replacement, min] of SUFFIX_RULES) {
    if (stem.endsWith(suffix) && stem.length - suffix.length >= min) {
      stem = stem.slice(0, stem.length - suffix.length) + replacement;
      break;
    }
  }

  // "running" → "runn" → "run"; keep "ll"/"ss"/"zz" doubles ("install", "access").
  if (stem !== lower && /([b-df-hj-kmnp-rtv-y])\1$/.test(stem) && !/(ll|ss|zz)$/.test(stem)) {
    stem = stem.slice(0, -1);
  }
  if (stem.length > 4 && stem.endsWith('e')) {
    stem = stem.slice(0, -1);
  }
  return stem;
}

// Words that say how a user feels about a topic ("clearer", "flaky",
// "noticeably", "honestly") or what kind of work they want ("investigate",
// "failure", "bug") rather than what the topic is. They still count for
// keyword scoring; they are never a task's distinctive topic words, so they
// alone cannot make a brief abstain.
const NON_TOPICAL_WORDS = new Set(
  (
    'actual annoying awful awkward bad basic beautiful better best big brittle broken buggy careful clean clear clever clumsy clunky ' +
    'complete confus confusing constant curious decent difficult dumb easy elegant entire ever extreme fast feel fine flaky fragile frank ' +
    'frequent friendly frustrating full general glitchy good great happy hard heavy helpful honest hopeful huge ideal important ' +
    'intermittent intuitive janky laggy large light little lovely main maybe messy minor modern mostly much nice noisy noticeable obvious ' +
    'occasional odd often overall painful perhaps pleasant polished poor possible pretty probable quick quiet quite random rare real ' +
    'rather reliable responsive rough seem serious simple skeptical slight slow sluggish small smart smooth snappy solid somehow ' +
    'sometime sometimes somewhat sporadic strange stupid sturdy subtle super terrible thorough tidy tiny total ugly unclear unfriendly ' +
    'unhappy unpleasant unreliable unstable usable useful useless usual verbose very weird worried worse worst ' +
    // Kinds of work and trouble.
    'behave behavior behaviour bug check crash debug diagnose error explain fail failure figure fix handle help idea improve ' +
    'improvement incorrect investigate issue missing problem question refactor regression repair tweak understand verify wrong'
  ).split(' '),
);

/**
 * True for a word that only evaluates, hedges, intensifies, or names a kind of
 * work (comparatives, -ly adverbs, and -s/-ed/-ing forms included).
 */
export function isNonTopicalWord(word) {
  const lower = String(word).toLowerCase();
  const forms = new Set([lower]);
  for (const [suffix, replacement] of [
    ['iest', 'y'], ['ier', 'y'], ['est', ''], ['er', ''], ['ily', 'y'], ['ably', 'able'], ['ibly', 'ible'], ['ly', ''],
    ['ing', ''], ['ing', 'e'], ['ed', ''], ['ed', 'e'], ['es', ''], ['s', ''],
  ]) {
    if (lower.endsWith(suffix) && lower.length - suffix.length >= 3) forms.add(lower.slice(0, lower.length - suffix.length) + replacement);
  }
  for (const form of [...forms]) {
    if (/(.)\1$/.test(form)) forms.add(form.slice(0, -1)); // "bigger" → "bigg" → "big"
    if (form.endsWith('i')) forms.add(`${form.slice(0, -1)}y`);
  }
  return [...forms].some((form) => NON_TOPICAL_WORDS.has(form));
}

/** Raw lowercase word tokens: letters and digits, split on everything else. */
export function splitWords(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 2 && !/^\d+$/.test(word));
}

/** Content terms for indexing: stopwords dropped, stemmed, order kept. */
export function indexTerms(text) {
  const terms = [];
  for (const word of splitWords(text)) {
    if (STOPWORDS.has(word)) continue;
    terms.push(stemWord(word));
  }
  return terms;
}

/** Unique query terms: stopwords and instruction framing dropped, stemmed. */
export function queryTerms(text) {
  const seen = new Set();
  const terms = [];
  for (const word of splitWords(text)) {
    if (STOPWORDS.has(word) || QUERY_FRAMING.has(word)) continue;
    const stem = stemWord(word);
    if (QUERY_FRAMING.has(stem) || seen.has(stem)) continue;
    seen.add(stem);
    terms.push(stem);
  }
  return terms;
}

/** The first raw word behind each query term, for disclosures ("japanes" → "Japanese"). */
export function queryTermOrigins(text) {
  const origins = new Map();
  for (const word of String(text ?? '').split(/[^A-Za-z0-9]+/)) {
    if (word.length < 2 || /^\d+$/.test(word)) continue;
    const stem = stemWord(word.toLowerCase());
    if (!origins.has(stem)) origins.set(stem, word);
  }
  return origins;
}

const K1 = 1.2;

/**
 * A fielded keyword index. `fields` maps a field name to `{ weight, b }`;
 * each document supplies text per field.
 */
export function createKeywordIndex(fields, documents) {
  const entries = documents.map((document) => {
    const perField = {};
    for (const name of Object.keys(fields)) {
      const terms = indexTerms(document.fields[name] ?? '');
      const counts = new Map();
      for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
      perField[name] = { counts, length: terms.length };
    }
    return { id: document.id, perField };
  });

  const averageLength = {};
  for (const name of Object.keys(fields)) {
    const total = entries.reduce((sum, entry) => sum + entry.perField[name].length, 0);
    averageLength[name] = entries.length > 0 ? Math.max(1, total / entries.length) : 1;
  }

  const documentFrequency = new Map();
  for (const entry of entries) {
    const seen = new Set();
    for (const name of Object.keys(fields)) {
      for (const term of entry.perField[name].counts.keys()) seen.add(term);
    }
    for (const term of seen) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }

  const count = entries.length;
  const idf = (term) => {
    const frequency = documentFrequency.get(term) ?? 0;
    return Math.log(1 + (count - frequency + 0.5) / (frequency + 0.5));
  };

  return {
    count,
    documentFrequency: (term) => documentFrequency.get(term) ?? 0,
    idf,
    /** `{ id, score, matched }` per document with any matched term. */
    score(terms) {
      const results = [];
      for (const entry of entries) {
        let score = 0;
        const matched = [];
        for (const term of terms) {
          let pseudo = 0;
          for (const [name, { weight, b }] of Object.entries(fields)) {
            const field = entry.perField[name];
            const frequency = field.counts.get(term);
            if (!frequency) continue;
            pseudo += (weight * frequency) / (1 - b + (b * field.length) / averageLength[name]);
          }
          if (pseudo === 0) continue;
          matched.push(term);
          score += idf(term) * ((pseudo * (K1 + 1)) / (K1 + pseudo));
        }
        if (matched.length > 0) results.push({ id: entry.id, score, matched });
      }
      return results;
    },
  };
}
