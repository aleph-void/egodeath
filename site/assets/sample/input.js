function checkLicense(key) {
  const parts = key.split("-");
  if (parts.length !== 4) return false;
  let sum = 0;
  for (const p of parts) sum += parseInt(p, 16);
  return sum % 97 === 42;
}
console.log(checkLicense("1A2B-3C4D-5E6F-7081"));
