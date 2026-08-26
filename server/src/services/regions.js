// ---------------------------------------------------------------------------
// Which Greenco office a job belongs to.
//
// Greenco operates from two limited companies — Greenco Group Limited in
// Manchester and Greenco Liverpool Limited in Liverpool — and each raises its
// own invoices from its own company in Greenco Invoicing. Which one bills the
// commission on a job is decided by WHERE THE JOB WAS, so it is read off the
// site address on the contractor's invoice rather than being remembered,
// chosen, or attached to the contractor (the same plumber works both cities).
//
// The postcode is the signal that means something. Manchester's areas go to
// Manchester and Liverpool's to Liverpool; the ground between them is split the
// way the business splits it — Warrington is worked from Manchester, St Helens
// from Liverpool. Anything genuinely in between resolves to NOTHING, on
// purpose: an address this can't place is one a person should place, and every
// answer carries the reason it gave so it can be checked and overridden.
//
// Pure — no DB, no config — so the rules are unit-tested directly and the same
// function decides what the extractor suggests and what the server stores.
// ---------------------------------------------------------------------------

export const REGIONS = [
  {
    key: 'manchester',
    label: 'Manchester',
    // The legal entity that invoices. Overridable in config; this is the name
    // the rules were written around.
    company: 'Greenco Group Limited',
  },
  {
    key: 'liverpool',
    label: 'Liverpool',
    company: 'Greenco Liverpool Limited',
  },
];

export const REGION_KEYS = REGIONS.map((r) => r.key);
export const REGION_LABEL = Object.fromEntries(REGIONS.map((r) => [r.key, r.label]));

export function isRegion(value) {
  return REGION_KEYS.includes(value);
}

// --- postcodes --------------------------------------------------------------

// A UK outward code is 1–2 letters, then 1–2 digits, then an optional letter:
// M1, M20, WA9, CH41, L1, EC1A. We only ever need the outward half.
const OUTWARD = /\b([A-Z]{1,2})(\d{1,2})([A-Z]?)\s*\d[A-Z]{2}\b/i;
const OUTWARD_ALONE = /\b([A-Z]{1,2})(\d{1,2})([A-Z]?)\b(?!\s*[A-Z]{2}\b)/i;

// Pull the postcode out of a free-text address. Prefers a full postcode
// (outward + inward), because an outward-looking fragment on its own is easy to
// confuse with a flat number — "Flat 2B" is not a postcode.
export function findOutwardCode(address) {
  const text = String(address || '').toUpperCase();
  const full = text.match(OUTWARD);
  if (full) return `${full[1]}${full[2]}${full[3]}`;

  // No inward half. Accept a bare outward code only as the last word of the
  // address, where a postcode is what it would be — mid-address it is just as
  // likely to be a flat or a door number.
  const last = text.split(/[,\n\s]+/).filter(Boolean).pop() || '';
  const alone = last.match(OUTWARD_ALONE);
  if (alone && alone[0] === last) return `${alone[1]}${alone[2]}${alone[3]}`;
  return null;
}

// An outward code on its own: M20, WA9, CH41, L1.
const OUTWARD_TOKEN = /^[A-Z]{1,2}\d{1,2}[A-Z]?$/;
// How far back from the end of the address to look for one. Invoices print the
// works date after the site address ("... CH41 ON 15/06/26"), which hides the
// postcode from findOutwardCode; three words of slack covers that without
// reaching back into the street.
const TRAILING_WORDS = 3;

// Look past whatever an invoice printed after the postcode. Only a code that
// lands in one of the two offices is accepted, so this can add an answer where
// there wasn't one but can never change one that was already found.
function trailingKnownOutward(text) {
  const tokens = String(text).toUpperCase().split(/[\s,\n]+/).filter(Boolean);
  for (let i = tokens.length - 1; i >= Math.max(0, tokens.length - 1 - TRAILING_WORDS); i -= 1) {
    if (!OUTWARD_TOKEN.test(tokens[i])) continue;
    const hit = regionForPostcode(tokens[i]);
    if (hit) return hit;
  }
  return null;
}

export function splitOutward(outward) {
  const m = String(outward || '')
    .toUpperCase()
    .match(/^([A-Z]{1,2})(\d{1,2})([A-Z]?)$/);
  return m ? { area: m[1], district: Number(m[2]) } : null;
}

// The postcode areas each office covers.
//
// Whole areas first — these are not in doubt. Greater Manchester is M (Manchester
// and Salford), BL (Bolton), OL (Oldham and Rochdale), SK (Stockport) and WN
// (Wigan); Merseyside proper is L (Liverpool, Bootle, Huyton, Kirkby, Ormskirk).
const WHOLE_AREAS = {
  M: 'manchester',
  BL: 'manchester',
  OL: 'manchester',
  SK: 'manchester',
  WN: 'manchester',
  L: 'liverpool',
};

// The areas that straddle the two, district by district. Everything not listed
// in a split area is left undecided rather than guessed.
const SPLIT_AREAS = {
  // WA is the boundary itself, and the business splits it the way the customer
  // described: Warrington is worked from Manchester, St Helens from Liverpool.
  WA: {
    manchester: {
      1: 'Warrington', 2: 'Warrington', 3: 'Warrington', 4: 'Warrington', 5: 'Warrington',
      13: 'Lymm', 14: 'Altrincham', 15: 'Hale', 16: 'Knutsford',
    },
    liverpool: {
      7: 'Runcorn', 8: 'Widnes',
      9: 'St Helens', 10: 'St Helens', 11: 'St Helens',
      12: 'Newton-le-Willows',
    },
    // WA6 (Frodsham) is deliberately absent: it is neither, and saying so is
    // more use than picking one.
  },
  // CH is Chester AND the Wirral. The Wirral is Merseyside and worked from
  // Liverpool; Chester itself is neither, so it is left to be chosen.
  CH: {
    liverpool: {
      41: 'Birkenhead', 42: 'Birkenhead', 43: 'Prenton', 44: 'Wallasey', 45: 'Wallasey',
      46: 'Upton', 47: 'Hoylake', 48: 'West Kirby', 49: 'Wirral',
      60: 'Heswall', 61: 'Wirral', 62: 'Bebington', 63: 'Bebington', 64: 'Ellesmere Port',
      65: 'Ellesmere Port', 66: 'Ellesmere Port',
    },
  },
  // PR is Preston, but its seaside end is Sefton — Southport is Merseyside.
  PR: {
    liverpool: { 8: 'Southport', 9: 'Southport' },
  },
};

// Towns, for the addresses that arrive without a postcode — plenty do, because
// the address is often read off a "Site" or "Reference" line on the invoice.
// Only names that place a job beyond argument are listed.
const TOWNS = {
  manchester: [
    'manchester', 'salford', 'stockport', 'oldham', 'rochdale', 'bury', 'bolton',
    'wigan', 'trafford', 'altrincham', 'sale', 'stretford', 'urmston', 'eccles',
    'swinton', 'worsley', 'prestwich', 'whitefield', 'radcliffe', 'middleton',
    'chadderton', 'failsworth', 'droylsden', 'denton', 'hyde', 'stalybridge',
    'dukinfield', 'ashton-under-lyne', 'wythenshawe', 'didsbury', 'chorlton',
    'levenshulme', 'withington', 'rusholme', 'gorton', 'openshaw', 'moston',
    'blackley', 'cheadle', 'bramhall', 'marple', 'leigh', 'atherton', 'tyldesley',
    'warrington',
  ],
  liverpool: [
    'liverpool', 'bootle', 'crosby', 'litherland', 'waterloo', 'aintree', 'walton',
    'anfield', 'everton', 'toxteth', 'wavertree', 'allerton', 'woolton', 'garston',
    'speke', 'aigburth', 'kensington', 'kirkdale', 'fazakerley', 'norris green',
    'west derby', 'huyton', 'kirkby', 'prescot', 'whiston', 'st helens',
    'saint helens', 'widnes', 'runcorn', 'birkenhead', 'wallasey', 'wirral',
    'bebington', 'heswall', 'hoylake', 'west kirby', 'southport', 'formby',
    'maghull', 'ormskirk', 'skelmersdale', 'newton-le-willows',
  ],
};

// A town name followed by a street word is a STREET, not a town: Liverpool Road
// runs through Eccles, and Manchester Road through half of Lancashire. Matching
// one of those would send the invoice to the wrong company.
const STREET_WORD =
  /^(road|rd|street|st|lane|ln|avenue|ave|way|drive|dr|close|court|crescent|terrace|row|walk|gardens?|grove|place|square|view|rise|park|bridge|gate|hill|end|old\s+road)\b/i;

function townRegion(address) {
  const text = ` ${String(address || '').toLowerCase().replace(/[^a-z\s-]/g, ' ').replace(/\s+/g, ' ')} `;
  for (const region of REGION_KEYS) {
    for (const town of TOWNS[region]) {
      const at = text.indexOf(` ${town} `);
      if (at === -1) continue;
      const after = text.slice(at + town.length + 2);
      if (STREET_WORD.test(after)) continue;
      return { region, town };
    }
  }
  return null;
}

// Which office a postcode belongs to. Returns null for a postcode that is
// neither office's ground — the caller asks a person rather than guessing.
export function regionForPostcode(postcode) {
  const parts = splitOutward(findOutwardCode(postcode) || postcode);
  if (!parts) return null;

  const whole = WHOLE_AREAS[parts.area];
  if (whole) return { region: whole, outward: `${parts.area}${parts.district}`, place: null };

  const split = SPLIT_AREAS[parts.area];
  if (split) {
    for (const region of REGION_KEYS) {
      const place = split[region]?.[parts.district];
      if (place) return { region, outward: `${parts.area}${parts.district}`, place };
    }
  }
  return null;
}

// Work out which office a job belongs to from its site address.
//
// Always returns a shape, never throws: `region` is null when the address
// can't be placed, and `reason` is a sentence a person can act on either way.
// The office for a job, with the contractor's usual one to fall back on.
//
// Order matters and is the whole point: what the address says wins, always. A
// contractor who normally works Liverpool still bills a Manchester postcode to
// Manchester — the fallback is for the invoice that doesn't say, not for the
// one that says something inconvenient. With no fallback set this is exactly
// regionForAddress(), so nothing changes for a contractor nobody has set one
// for.
export function regionForJob(address, fallback = null, who = 'This contractor') {
  const detected = regionForAddress(address);
  if (detected.region || !isRegion(fallback)) return detected;
  return {
    region: fallback,
    reason: `${detected.reason} ${who} is set to ${REGION_LABEL[fallback]} by default.`,
    source: 'contractor_default',
    postcode: detected.postcode,
  };
}

export function regionForAddress(address) {
  const text = String(address || '').trim();
  if (!text) {
    return { region: null, reason: 'No property address to work it out from.', source: null };
  }

  const outward = findOutwardCode(text);
  if (outward) {
    const hit = regionForPostcode(outward);
    if (hit) {
      return {
        region: hit.region,
        reason: `${outward} is ${hit.place || REGION_LABEL[hit.region]}.`,
        source: 'postcode',
        postcode: outward,
      };
    }
    // A postcode we recognise as a postcode but not as either office's ground:
    // say that, rather than falling through to a town name that might be the
    // sorting office's rather than the property's.
    return {
      region: null,
      reason: `${outward} is not in either office's area.`,
      source: null,
      postcode: outward,
    };
  }

  // No postcode where one would be, but there may be one with the works date
  // printed after it. A town name is the weaker signal, so this is tried first.
  const trailing = trailingKnownOutward(text);
  if (trailing) {
    const code = `${trailing.outward}`;
    return {
      region: trailing.region,
      reason: `${code} is ${trailing.place || REGION_LABEL[trailing.region]}.`,
      source: 'postcode',
      postcode: code,
    };
  }

  const town = townRegion(text);
  if (town) {
    return {
      region: town.region,
      reason: `No postcode on the invoice — placed by "${town.town}".`,
      source: 'town',
    };
  }

  return {
    region: null,
    reason: 'No postcode or recognised town in the property address.',
    source: null,
  };
}
