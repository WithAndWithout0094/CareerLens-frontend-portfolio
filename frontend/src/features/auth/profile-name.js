// Keep this contract aligned with normalize_profile_name on the API. Length
// uses UTF-16 units, matching the existing HTML maxlength="80" on both forms.
export function validatedProfileName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f\u2028\u2029]/.test(name)) return null;
  // for...of visits valid surrogate pairs together and lone surrogates alone.
  for (const character of name) {
    const point = character.codePointAt(0);
    if (point >= 0xd800 && point <= 0xdfff) return null;
  }
  return name;
}
