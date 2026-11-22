// Fixed option lists for the roommate profile + roommate filter. Same reasoning
// as amenities.js: fixed lists (not free text) so filtering actually matches.
// Everything here is OPTIONAL and opt-in — a student's tags only count toward
// filters once they switch on "share with roommates" (see routes/auth.js).

export const ROOMMATE_INTERESTS = [
  "Music", "Movies & Series", "Gaming", "Reading", "Cooking", "Fashion",
  "Photography", "Travel", "Art & Design", "Tech & Coding", "Dancing",
  "Church / Fellowship", "Business & Hustling", "Content Creation",
];

export const ROOMMATE_SPORTS = [
  "Football", "Basketball", "Volleyball", "Table Tennis", "Gym / Fitness",
  "Running", "Swimming", "Chess / Ludo / Draughts", "Athletics", "Tennis",
];

// Lifestyle = the day-to-day things roommates actually clash over.
export const ROOMMATE_LIFESTYLE = [
  "Early riser", "Night owl", "Quiet / studious", "Social / hosts friends",
  "Neat & tidy", "Relaxed about mess", "Doesn't smoke", "Doesn't drink",
  "Okay with music in the room",
];

// Optional and sensitive: single choice, never required, only ever used to
// match people who CHOOSE to share it. Leaving it blank is always allowed.
export const ROOMMATE_RELIGIONS = ["Christian", "Muslim", "Traditional", "Other", "No religion"];

export const ROOMMATE_OPTIONS = {
  interests: ROOMMATE_INTERESTS,
  sports: ROOMMATE_SPORTS,
  lifestyle: ROOMMATE_LIFESTYLE,
  religions: ROOMMATE_RELIGIONS,
};

/** Keep only values that exist in the fixed list (drops junk/duplicates). */
export function pickAllowed(values, allowed) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values)].filter((v) => allowed.includes(v));
}
