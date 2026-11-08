// Judging guide shown from the "📖 Judging guide" button on the scoring
// screen. Empty array = button hidden. Blocks: { h } heading, { p } paragraph,
// { ul: [...] } bullets, { motto } centered line. **text** renders bold.
// FLOWER version: 4 categories, no rosin/melt/dab wording. Criteria text
// matches the category descriptions judges see in the app.
export const GUIDE_DRAFT = [
  { h: 'Our Goal' },
  { p: 'Our mission is to create a fair, unbiased, and consistent environment to determine who has grown the best flower. As judges, we carry the responsibility of treating each sample with equal care and diligence, as the livelihoods and reputations of many talented growers are in our hands. Let’s celebrate exceptional flower together!' },

  { h: 'Judging Criteria' },
  { p: 'Each sample is flower and will be evaluated based on the following four key aspects:' },
  { ul: [
    '**Aroma** – Are the terpenes pronounced or muted? Do you detect any degradation or off-notes? Does the aroma have depth, or does it fall flat? How does it make you feel?',
    '**Taste** – How does the smoke coat your palate? Is the flavor long-lasting and true to the aroma? Does it stand out as exotic, or is it more standard?',
    '**Ash Quality** – Does it burn clean and even? Does the ash turn a light gray to white, or is it dark and sooty from contaminants, residual nutrients, or an incomplete cure/flush? How does the hit feel on your throat and lungs?',
    '**Experience** – How is the high? How is the lasting taste on your palate?',
  ] },
  { p: '**Why no Appearance?** There are both indoor and outdoor entries this year, so Appearance is not scored. We want every category being scored to be a fair playing field.' },

  { h: 'Scoring Format' },
  { p: 'Each sample should be scored out of **100 points**. Once complete, submit your final scorecard with the **Submit my scores** button at the bottom of the screen.' },
  { p: 'You never rank entries yourself. Your scores set your ranking, and your ranking decides how the entries place overall. Just enter your scores and the ranking is worked out for you.' },

  { motto: 'Respect the Flower. Respect the Grower.' },
  { ul: [
    'Revisit each sample more than once before settling on a score.',
    'Record detailed notes for each session in Dababase.',
    'After multiple sessions with each sample, finalize your scores.',
    'The overall rankings will be shared at the event. The entry-by-entry scoring breakdown will be provided the following week.',
  ] },

  { h: 'Judging Requirements' },
  { ul: [
    'Use a **clean piece or fresh papers** for every sample so flavors don’t carry over.',
    'Consume each sample the same way so every entry gets a fair comparison.',
    'Submit all final scores by **3PM on Friday November 13th**.',
    'Please **do not discuss samples** with other judges or growers to maintain objectivity.',
    'We love when you share your judge experience live, but please keep what jar you are smoking anonymous to keep anonymity during judging.',
  ] },

  { h: 'Scoring Expectations' },
  { p: 'Each sample is scored out of **100**, where **100 is a perfect score** and **1 is the lowest possible score**.' },
  { ul: [
    'A proper scorecard should have a **wide range of scores**.',
    'Work to **avoid ties** in your scoring. If two samples receive the same score, **re-evaluate** and adjust accordingly.',
    'Statistically, it is improbable for multiple samples to receive the exact same score.',
    'It is also unlikely to see scores above **95** or below **40**.',
  ] },

  { h: 'Transparency & Exposure' },
  { p: 'We encourage you to share your judging experience! Tag **@HeadyHappeningSesh** and **@FireFarmsMaui** and help keep our traditions alive while inspiring future connoisseurs.' },
];

// Hidden until the drafted Flower wording above is approved.
export const GUIDE = GUIDE_DRAFT; // sandbox: preview of the Flower draft
