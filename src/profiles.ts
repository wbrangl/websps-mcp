export const PROFILES = ["read", "operate", "develop", "admin"] as const;

export type Profile = (typeof PROFILES)[number];

/** Profiles are nested: `read` ⊂ `operate` ⊂ `develop` ⊂ `admin`. */
export function profileAllows(configured: Profile, required: Profile): boolean {
  return PROFILES.indexOf(configured) >= PROFILES.indexOf(required);
}
