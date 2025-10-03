export const TRAVEL_THEME_AUDIENCE_REPLACEMENTS: Record<string, string> = {
  lover: 'lovers',
  lovers: 'lovers',
  "lover's": 'lovers',
  enthusiast: 'enthusiasts',
  enthusiasts: 'enthusiasts',
  "enthusiast's": 'enthusiasts',
  fan: 'fans',
  fans: 'fans',
  "fan's": 'fans',
  fanatic: 'fanatics',
  fanatics: 'fanatics',
  "fanatic's": 'fanatics',
  buff: 'buffs',
  buffs: 'buffs',
  "buff's": 'buffs',
  seeker: 'seekers',
  seekers: 'seekers',
  "seeker's": 'seekers',
  hunter: 'hunters',
  hunters: 'hunters',
  "hunter's": 'hunters',
  aficionado: 'aficionados',
  aficionados: 'aficionados',
  "aficionado's": 'aficionados',
  devotee: 'devotees',
  devotees: 'devotees',
  "devotee's": 'devotees',
  geek: 'geeks',
  geeks: 'geeks',
  "geek's": 'geeks',
  nerd: 'nerds',
  nerds: 'nerds',
  "nerd's": 'nerds',
  junkie: 'junkies',
  junkies: 'junkies',
  "junkie's": 'junkies',
  addict: 'addicts',
  addicts: 'addicts',
  "addict's": 'addicts',
};

export const TRAVEL_THEME_INDICATOR_PATTERN =
  "(?:lover(?:s)?|lover['’]s|enthusiast(?:s)?|enthusiast['’]s|fan(?:s)?|fan['’]s|fanatic(?:s)?|fanatic['’]s|buff(?:s)?|buff['’]s|seeker(?:s)?|seeker['’]s|hunter(?:s)?|hunter['’]s|aficionado(?:s)?|aficionado['’]s|devotee(?:s)?|devotee['’]s|geek(?:s)?|geek['’]s|nerd(?:s)?|nerd['’]s|junkie(?:s)?|junkie['’]s|addict(?:s)?|addict['’]s)";

export const TRAVEL_THEME_AUDIENCE_TERMS: ReadonlySet<string> = new Set(
  Object.values(TRAVEL_THEME_AUDIENCE_REPLACEMENTS).map((value) => value.toLowerCase())
);
