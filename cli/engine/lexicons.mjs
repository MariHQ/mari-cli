// Wordlists and avoid→use maps. Weights on overused words = measured over-use ratios
// (PITCH §2/§10); Tier 1 has hard numbers, Tier 2 is mid, heuristic is low-confidence.

export const OVERUSED_WEIGHTS = {
  // Tier 1 — measured excess ratios
  delve: 28, delves: 28, delving: 28, delved: 28,
  meticulous: 34.7, meticulously: 34.7,
  intricate: 11.2, intricately: 11.2,
  commendable: 9.8, commendably: 9.8,
  underscore: 13.8, underscores: 13.8, underscoring: 13.8, underscored: 13.8,
  showcase: 10.7, showcases: 10.7, showcasing: 10.7, showcased: 10.7,
  // Tier 2 — strong but unquantified
  realm: 4, pivotal: 4, garner: 4, garners: 4, garnered: 4,
  boasts: 4, boast: 4, adept: 4, groundbreaking: 4,
  // heuristic — low weight, no hard evidence
  tapestry: 1.5, testament: 1.5, leverage: 1.5, leveraging: 1.5,
  robust: 1.5, seamless: 1.5, seamlessly: 1.5, nuanced: 1.5,
  multifaceted: 1.5, potential: 1.2,
};

export const MARKETING_BUZZWORDS = [
  'streamline', 'streamlines', 'streamlining', 'empower', 'empowers', 'empowering',
  'supercharge', 'supercharges', 'world-class', 'enterprise-grade', 'cutting-edge',
  'game-changing', 'game changer', 'next-generation', 'next-gen', 'best-in-class',
  'turnkey', 'mission-critical', 'synergy', 'synergies', 'holistic', 'paradigm shift',
  'frictionless', 'bleeding-edge', 'unparalleled', 'unrivaled',
];

export const HEDGES = [
  'it could be argued', 'arguably', 'to some extent', 'in many ways', 'in some ways',
  'more often than not', 'generally speaking', 'broadly speaking', 'in a sense',
  'for all intents and purposes', 'tends to', 'somewhat', 'sort of', 'kind of',
];

export const WEASEL_WORDS = [
  'very', 'really', 'quite', 'fairly', 'rather', 'somewhat', 'just', 'basically',
  'actually', 'simply', 'literally', 'extremely', 'incredibly', 'totally',
];

// avoid → preferred. Concision-oriented.
export const WORDY_PHRASES = {
  'in order to': 'to',
  'due to the fact that': 'because',
  'at this point in time': 'now',
  'at the present time': 'now',
  'in the event that': 'if',
  'in spite of the fact that': 'although',
  'with regard to': 'about',
  'with respect to': 'about',
  'for the purpose of': 'to',
  'has the ability to': 'can',
  'have the ability to': 'can',
  'a number of': 'some',
  'a majority of': 'most',
  'in the near future': 'soon',
  'on a regular basis': 'regularly',
  'in close proximity to': 'near',
  'take into consideration': 'consider',
};

export const COMPLEX_WORDS = {
  utilize: 'use', utilizes: 'use', utilizing: 'use', utilization: 'use',
  facilitate: 'help', facilitates: 'help', commence: 'start', commences: 'start',
  endeavor: 'try', ascertain: 'find out', numerous: 'many', sufficient: 'enough',
  methodology: 'method', additional: 'more', approximately: 'about', demonstrate: 'show',
  demonstrates: 'show', individuals: 'people', subsequently: 'later', prior: 'before',
  initiate: 'start', terminate: 'end', component: 'part', functionality: 'features',
};

// Style-guide term swaps (Microsoft/Google), kept distinct from concision swaps above.
export const WORD_SWAP = {
  leverage: 'use', 'e.g.': 'for example', 'i.e.': 'that is', etc: 'and so on',
  abort: 'stop', execute: 'run', 'grayed out': 'unavailable', 'and/or': 'or',
  deselect: 'clear', login: 'sign in (verb)', 'log in': 'sign in', 'e-mail': 'email',
  'check box': 'checkbox', 'drop-down': 'dropdown',
};

export const NOMINALIZATIONS = {
  'make a decision': 'decide', 'made a decision': 'decided',
  'conduct an investigation': 'investigate', 'provide assistance': 'assist',
  'give consideration to': 'consider', 'reach a conclusion': 'conclude',
  'perform an analysis': 'analyze', 'make an assumption': 'assume',
  'come to an agreement': 'agree', 'take action': 'act', 'make a contribution': 'contribute',
  'provide a description': 'describe', 'make an improvement': 'improve',
};

export const REDUNDANT_PAIRS = [
  'each and every', 'first and foremost', 'end result', 'free gift', 'past history',
  'future plans', 'various different', 'absolutely essential', 'advance planning',
  'close proximity', 'basic fundamentals', 'completely eliminate', 'final outcome',
  'unexpected surprise', 'added bonus', 'new innovation', 'true fact',
];

export const GENDERED = {
  chairman: 'chair', chairmen: 'chairs', mankind: 'humanity', manpower: 'workforce',
  'man-hours': 'person-hours', manned: 'staffed', salesman: 'salesperson',
  salesmen: 'salespeople', policeman: 'police officer', policemen: 'police officers',
  layman: 'layperson', laymen: 'laypeople', freshman: 'first-year student',
  fireman: 'firefighter', firemen: 'firefighters', stewardess: 'flight attendant',
  mailman: 'mail carrier', businessman: 'businessperson', 'man-made': 'artificial',
};

// metaphorical ableist terms (warn) vs CS-idiomatic (advisory)
export const ABLEIST_WARN = {
  crazy: 'wild / baffling', insane: 'extreme', psycho: 'erratic', lame: 'weak',
  dumb: 'foolish', 'tone-deaf': 'insensitive', cripple: 'degrade', cripples: 'degrades',
  crippling: 'degrading',
};
export const ABLEIST_ADVISORY = {
  'sanity check': 'consistency check', sane: 'reasonable', 'dummy value': 'placeholder value',
};

export const VAGUE_LINK_TEXT = ['click here', 'here', 'read more', 'this', 'this link', 'link', 'more'];

// ---- additional Family A lexicons -----------------------------------------

export const CONVERSATIONAL_SCAFFOLDING = [
  "let's delve into", "let's break this down", "let's dive in", 'think of it as',
  'think of it like', 'imagine a world where', 'to put it simply', "here's the kicker",
  "here's the thing", 'buckle up', 'spoiler alert', 'plot twist',
];

export const TRANSITION_WORDS = ['Additionally', 'Moreover', 'Furthermore', 'However', 'Consequently', 'Nevertheless'];

export const SERVES_AS = ['serves as', 'serve as', 'stands as', 'stand as', 'acts as', 'functions as', 'represents a', 'exemplifies', 'embodies'];

export const SUPERFICIAL_ING = ['highlighting', 'underscoring', 'emphasizing', 'reflecting', 'symbolizing', 'showcasing', 'contributing to', 'fostering', 'ensuring', 'paving the way'];

export const MEDIA_COVERAGE = ['featured in', 'profiled in', 'has been featured', 'and other prominent outlets', 'maintains a strong', 'a strong social media presence', 'an active digital presence', 'garnered attention'];

export const FUTURE_OUTLOOK = ['the future of', 'evolving landscape', 'continues to evolve', 'is poised to', 'on the horizon', 'in the years to come', 'only time will tell', 'the road ahead'];

// ---- additional Family B -------------------------------------------------

export const MINIMIZING_WORDS = ['easy', 'easily', 'simple', 'simply', 'just', 'quick', 'quickly', 'obviously', 'of course', 'merely', 'trivial'];

// ---- Family C: contractions, latinisms, spelling, directional -------------

export const CONTRACTIONS = {
  'do not': "don't", 'does not': "doesn't", 'did not': "didn't", 'is not': "isn't",
  'are not': "aren't", 'was not': "wasn't", 'were not': "weren't", 'cannot': "can't",
  'can not': "can't", 'will not': "won't", 'would not': "wouldn't", 'should not': "shouldn't",
  'could not': "couldn't", 'have not': "haven't", 'has not': "hasn't", 'it is': "it's",
  'you are': "you're", 'we are': "we're", 'they are': "they're", 'you will': "you'll",
};

export const GENDERED_PRONOUN_PAIRS = {
  'he or she': 'they', 'she or he': 'they', 'his or her': 'their', 'her or his': 'their',
  'him or her': 'them', 'he/she': 'they', '(s)he': 'they', 's/he': 'they', 'his/her': 'their',
};

export const LATINISMS = { 'e.g.': 'for example', 'i.e.': 'that is', 'etc.': 'and so on', 'etc': 'and so on', 'via': 'through', 'vs.': 'versus' };

export const BRITISH_SPELLINGS = {
  colour: 'color', colours: 'colors', favour: 'favor', behaviour: 'behavior',
  flavour: 'flavor', honour: 'honor', labour: 'labor', neighbour: 'neighbor',
  organise: 'organize', organised: 'organized', recognise: 'recognize', analyse: 'analyze',
  catalogue: 'catalog', dialogue: 'dialog', centre: 'center', metre: 'meter',
  licence: 'license', defence: 'defense', grey: 'gray', cancelled: 'canceled',
  travelling: 'traveling', modelling: 'modeling',
};

export const PREANNOUNCE = ['currently', 'presently', 'at this time', 'latest', 'newest', 'brand-new', 'soon', 'in the near future', 'upcoming'];

export const DIRECTIONAL = { above: 'preceding', below: 'following' };

// concept variants → flag if two distinct variants of the same concept appear
export const TERM_VARIANTS = [
  ['sign in', 'log in', 'login'], ['email', 'e-mail'], ['dropdown', 'drop-down'],
  ['website', 'web site'], ['checkbox', 'check box'], ['filename', 'file name'],
  ['setup', 'set-up'], ['username', 'user name'],
];

// ---- Family D additional --------------------------------------------------

export const PERSON_FIRST = {
  'suffers from': 'has', 'suffering from': 'living with', 'victim of': 'person affected by',
  'wheelchair-bound': 'wheelchair user', 'confined to a wheelchair': 'uses a wheelchair',
  'an epileptic': 'a person with epilepsy', 'the disabled': 'disabled people',
  'the mentally ill': 'people with mental illness', 'normal people': 'people without disabilities',
};

export const GENDERED_ADDRESS = { guys: 'everyone / folks', gentlemen: 'everyone', ladies: 'everyone', 'you guys': 'you all' };

export const TECH_HISTORICAL = {
  blacklist: 'blocklist', blacklists: 'blocklists', blacklisted: 'blocked',
  whitelist: 'allowlist', whitelists: 'allowlists', whitelisted: 'allowed',
  'master/slave': 'primary/replica', grandfathered: 'legacy', grandfather: 'legacy',
  blackhat: 'unethical', whitehat: 'ethical', 'first-class citizen': 'fully supported',
  sanity: 'confidence',
};
// high-FP terms → advisory only, with exemptions handled in the rule
export const TECH_HISTORICAL_ADVISORY = { master: 'primary / main', slave: 'replica / worker', native: 'built-in', primitive: 'basic', tribe: 'team' };

export const VIOLENT_TECH = {
  abort: 'stop', aborts: 'stops', kill: 'end', killing: 'ending', hang: 'stop responding',
  hangs: 'stops responding', 'blast radius': 'scope of impact', dmz: 'perimeter network',
  // note: "hit" intentionally excluded — "cache hit", "hit the endpoint" are standard, not violent
};

export const AGEIST_CLASSIST = {
  ghetto: 'makeshift', gypsy: 'traveler', gypped: 'cheated', oriental: 'Asian',
  eskimo: 'Inuit', 'third-world': 'developing', 'third world': 'developing',
  'the elderly': 'older adults', 'illegal immigrant': 'undocumented immigrant',
  'illegal alien': 'undocumented immigrant', sketchy: 'questionable',
};

// ---- Family E additional --------------------------------------------------

export const REDUNDANT_ACRONYMS = [
  'ATM machine', 'PIN number', 'LCD display', 'HIV virus', 'RAM memory', 'PDF format',
  'ISBN number', 'GPS system', 'CPU unit', 'UPC code', 'NIC card', 'please RSVP',
  'HTTP protocol', 'IP protocol', 'SIN number', 'VIN number',
];

// a/an exceptions (sound-based, not letter-based)
export const AN_BEFORE_CONSONANT_LETTER = ['hour', 'honest', 'honor', 'heir', 'honour']; // need "an"
export const A_BEFORE_VOWEL_LETTER = ['university', 'unicorn', 'unique', 'unit', 'user', 'used', 'useful', 'european', 'one', 'once', 'ubiquitous', 'url', 'ui', 'utility', 'eulogy']; // need "a"
