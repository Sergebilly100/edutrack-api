/**
 * Nationalités : codes pays ISO 3166-1 alpha-2, noms français (Intl) et gentilés.
 * Fichier sans dépendance, dupliqué à l'identique côté frontend (edutrack-web/src/lib/nationality.ts).
 */

const ISO_CODES = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
  'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP ' +
  'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT ' +
  'MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW ' +
  'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG ' +
  'UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' ');

const COUNTRY_CODES: ReadonlySet<string> = new Set(ISO_CODES);

// Surcharges : apostrophe droite et noms usuels en Côte d'Ivoire.
const NAME_OVERRIDES: Readonly<Record<string, string>> = {
  CI: "Côte d'Ivoire",
  CD: 'RD Congo',
  CG: 'Congo',
};

/** [masculin, féminin] */
const DEMONYMS: Readonly<Record<string, readonly [string, string]>> = {
  CI: ['Ivoirien', 'Ivoirienne'], BF: ['Burkinabè', 'Burkinabè'], ML: ['Malien', 'Malienne'],
  GN: ['Guinéen', 'Guinéenne'], SN: ['Sénégalais', 'Sénégalaise'], GH: ['Ghanéen', 'Ghanéenne'],
  BJ: ['Béninois', 'Béninoise'], TG: ['Togolais', 'Togolaise'], NE: ['Nigérien', 'Nigérienne'],
  NG: ['Nigérian', 'Nigériane'], LR: ['Libérien', 'Libérienne'], CM: ['Camerounais', 'Camerounaise'],
  GA: ['Gabonais', 'Gabonaise'], CG: ['Congolais', 'Congolaise'], CD: ['Congolais', 'Congolaise'],
  MR: ['Mauritanien', 'Mauritanienne'], MA: ['Marocain', 'Marocaine'], DZ: ['Algérien', 'Algérienne'],
  TN: ['Tunisien', 'Tunisienne'], FR: ['Français', 'Française'], LB: ['Libanais', 'Libanaise'],
  SL: ['Sierra-Léonais', 'Sierra-Léonaise'], GW: ['Bissau-Guinéen', 'Bissau-Guinéenne'],
  CV: ['Cap-Verdien', 'Cap-Verdienne'], GM: ['Gambien', 'Gambienne'], TD: ['Tchadien', 'Tchadienne'],
  CF: ['Centrafricain', 'Centrafricaine'], GQ: ['Équato-Guinéen', 'Équato-Guinéenne'],
  EG: ['Égyptien', 'Égyptienne'], BE: ['Belge', 'Belge'], CH: ['Suisse', 'Suisse'],
  DE: ['Allemand', 'Allemande'], ES: ['Espagnol', 'Espagnole'], IT: ['Italien', 'Italienne'],
  PT: ['Portugais', 'Portugaise'], GB: ['Britannique', 'Britannique'], US: ['Américain', 'Américaine'],
  CA: ['Canadien', 'Canadienne'], CN: ['Chinois', 'Chinoise'], IN: ['Indien', 'Indienne'],
  SY: ['Syrien', 'Syrienne'], HT: ['Haïtien', 'Haïtienne'], BR: ['Brésilien', 'Brésilienne'],
  RU: ['Russe', 'Russe'], BI: ['Burundais', 'Burundaise'], RW: ['Rwandais', 'Rwandaise'],
  MG: ['Malgache', 'Malgache'], KE: ['Kényan', 'Kényane'], ZA: ['Sud-Africain', 'Sud-Africaine'],
  AO: ['Angolais', 'Angolaise'], DJ: ['Djiboutien', 'Djiboutienne'], ET: ['Éthiopien', 'Éthiopienne'],
};

let regionNames: Intl.DisplayNames | null | undefined;
const getRegionNames = (): Intl.DisplayNames | null => {
  if (regionNames === undefined) {
    try { regionNames = new Intl.DisplayNames(['fr'], { type: 'region' }); } catch { regionNames = null; }
  }
  return regionNames;
};

export const normalizeCountryCode = (value: string): string => value.trim().toUpperCase();
export const isValidCountryCode = (value: string): boolean => COUNTRY_CODES.has(value);
export const listCountryCodes = (): readonly string[] => ISO_CODES;

/** Nom français du pays ; le code lui-même si le code est inconnu. */
export const getCountryName = (code: string): string => {
  const normalized = normalizeCountryCode(code);
  if (NAME_OVERRIDES[normalized]) return NAME_OVERRIDES[normalized];
  if (!COUNTRY_CODES.has(normalized)) return code;
  try { return getRegionNames()?.of(normalized) ?? normalized; } catch { return normalized; }
};

/** Gentilé selon le sexe ('F' → féminin, sinon masculin). Repli : nom du pays. */
export const getDemonym = (code: string, sex?: 'M' | 'F' | null): string => {
  const entry = DEMONYMS[normalizeCountryCode(code)];
  if (!entry) return getCountryName(code);
  return sex === 'F' ? entry[1] : entry[0];
};

/** Liste triée pour une liste déroulante : Côte d'Ivoire en tête, puis ordre alphabétique français. */
export const listCountries = (): Array<{ code: string; name: string }> => {
  const all = ISO_CODES.map((code) => ({ code, name: getCountryName(code) }));
  const rest = all.filter((country) => country.code !== 'CI').sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  return [{ code: 'CI', name: getCountryName('CI') }, ...rest];
};

export const foldText = (value: string): string =>
  value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

let lookup: Map<string, string> | undefined;
const getLookup = (): Map<string, string> => {
  if (lookup) return lookup;
  const map = new Map<string, string>();
  // Gentilés d'abord, puis noms : un nom de pays l'emporte en cas de collision (cf. Congo).
  for (const [code, [masculine, feminine]] of Object.entries(DEMONYMS)) {
    if (!map.has(foldText(masculine))) map.set(foldText(masculine), code);
    if (!map.has(foldText(feminine))) map.set(foldText(feminine), code);
  }
  for (const code of ISO_CODES) map.set(foldText(getCountryName(code)), code);
  // « Congo » (CG) et « Congolais » (CG) : le gentilé « Congolais » reste associé à CG par défaut.
  lookup = map;
  return map;
};

/** Code pays depuis un code, un nom de pays ou un gentilé (accents/casse tolérés). null si non reconnu. */
export const parseNationality = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^[A-Za-z]{2}$/.test(trimmed) && COUNTRY_CODES.has(trimmed.toUpperCase())) return trimmed.toUpperCase();
  return getLookup().get(foldText(trimmed)) ?? null;
};
