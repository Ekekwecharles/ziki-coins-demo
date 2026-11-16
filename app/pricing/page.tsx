import type { Metadata } from 'next';
import Link from 'next/link';
import { pageMetadata } from '@/lib/seo/site';
import { optionalUser } from '@/lib/auth-helpers';
import { MarketingPage } from '@/components/homepage/marketing-page';
import { Icon } from '@/components/homepage/icon';
import { UrlNotice } from '@/components/coins/url-notice';
import { subscribeAction } from '@/app/actions/coins';
import { ZIK_PACKS, formatUsd, zikToCents } from '@/lib/coins/math';
import { ZIK_PLANS, discountedCents, findPlan, planBreakEvenCents } from '@/lib/coins/plans';
import { stripeConfigured } from '@/lib/coins/stripe';
import { liveSubscriptionOf } from '@/lib/coins/subscription';
import '@/components/homepage/pricing.css';

export const metadata: Metadata = pageMetadata({
  title: 'Pricing',
  description: 'Ziks fund the work on your issues. Subscribe to a Ziki plan and every Ziks pack you buy costs less. Pick Plus, Pro or Team, and end it any time.',
  path: '/pricing',
});

const FREE_POINTS = ['Fund issues with Ziks', 'Unlock security fixes', 'Withdraw what you earn'];

const FAQ: { question: string; answer: string }[] = [
  {
    question: 'What are Ziks?',
    answer: 'Ziks are Ziki’s coins. You put them behind an issue to say what the fix is worth, and the people who solve and review it are paid from them when the work is live. You can also spend them to unlock security fixes. One Zik is 10 cents.',
  },
  {
    question: 'What does a plan give me?',
    answer: 'A percentage off every Ziks pack you buy, for as long as your plan is paid up. You still get the pack’s full Ziks; you just pay less for them. A plan doesn’t add Ziks to your account by itself.',
  },
  {
    question: 'Which plan should I pick?',
    answer: 'Look at the “pays for itself” line on each plan. It is how many dollars of Ziks you would buy in a month for the discount to equal the plan’s price. Buy less than that and Free costs you less; buy more and a plan saves you money.',
  },
  {
    question: 'Can I cancel?',
    answer: 'Yes, any time, from the Ziks page. Your plan keeps running until the end of the month you have paid for, and your discount stays until then. You can change your mind and keep it before it ends.',
  },
  {
    question: 'What if a payment fails?',
    answer: 'Stripe tries the card again. Until it goes through, your discount is paused and packs cost the standard price. Nothing you already bought is affected.',
  },
  {
    question: 'Do I need a plan to earn Ziks?',
    answer: 'No. A plan only changes what you pay when you buy Ziks. Solving, reviewing and withdrawing what you earn work the same on every plan, including Free.',
  },
];

export default async function PricingPage({ searchParams }: { searchParams?: Promise<{ error?: string }> }) {
  const [user, query] = await Promise.all([optionalUser(), searchParams ?? Promise.resolve({} as { error?: string })]);
  const signedIn = Boolean(user);
  const subscription = user ? await liveSubscriptionOf(user.id) : null;
  const current = subscription ? findPlan(subscription.planId) : null;
  const configured = stripeConfigured();
  const loginHref = `/login?callbackUrl=${encodeURIComponent('/pricing')}`;

  return (
    <MarketingPage
      signedIn={signedIn}
      kicker="Pricing"
      title={<>Simple plans.<br />Cheaper Ziks.</>}
      lede="Ziks fund the work on your issues. Subscribe to a Ziki plan and every Ziks pack you buy costs less, for as long as you stay subscribed."
      actions={<>
        <Link className="th-btn th-btn-dark th-btn-lg" href={signedIn ? '/coins' : loginHref}>{signedIn ? 'Buy Ziks' : 'Get started'}</Link>
        <Link className="th-btn th-btn-light th-btn-lg" href="/how-it-works">How it works</Link>
      </>}
    >
      <section className="section pricing-section" id="plans">
        <div className="section-heading">
          <span className="section-kicker">Plans</span>
          <h2>Pick the plan that fits<br />what you spend on Ziks</h2>
          <p>Every plan takes a percentage off every Ziks pack you buy, and you always get the pack’s full Ziks. End it any time.</p>
        </div>

        {query.error ? <UrlNotice role="alert" className="pr-error">{query.error}</UrlNotice> : null}

        <div className="pr-grid">
          <article className="pr-card">
            <h3>Free</h3>
            <p className="pr-price"><b>$0</b><span>no monthly fee</span></p>
            <p className="pr-offer">Packs at the standard price</p>
            <ul className="pr-points">{FREE_POINTS.map((point) => <li key={point}>{point}</li>)}</ul>
            <div className="pr-action">
              {signedIn && !current ? (
                <span className="pr-badge">Your plan</span>
              ) : (
                <Link className="button button-large button-secondary" href={signedIn ? '/coins' : loginHref}>{signedIn ? 'Buy Ziks' : 'Start free'}</Link>
              )}
            </div>
          </article>

          {ZIK_PLANS.map((plan) => {
            const isCurrent = current?.id === plan.id;
            return (
              <article className={`pr-card${plan.id === 'pro' ? ' pr-featured' : ''}${isCurrent ? ' pr-current' : ''}`} key={plan.id}>
                {plan.id === 'pro' ? <span className="pr-tag">Most popular</span> : null}
                <h3>{plan.label}</h3>
                <p className="pr-price"><b>{formatUsd(plan.monthlyCents)}</b><span>a month</span></p>
                <p className="pr-offer">{plan.discountPercent}% off every Ziks pack</p>
                <ul className="pr-points">
                  <li>Pays for itself from {formatUsd(planBreakEvenCents(plan))} of Ziks a month</li>
                  <li>The pack’s full Ziks every time</li>
                  <li>End any time, keep the month you paid for</li>
                </ul>
                <div className="pr-action">
                  {isCurrent ? (
                    <>
                      <span className="pr-badge">Your plan</span>
                      <Link className="pr-link" href="/coins">Manage on the Ziks page</Link>
                    </>
                  ) : current ? (
                    <Link className="pr-link" href="/coins">End your plan first to switch</Link>
                  ) : !signedIn ? (
                    <Link className="button button-large" href={loginHref}>Subscribe</Link>
                  ) : (
                    <form action={subscribeAction}>
                      <input type="hidden" name="planId" value={plan.id} />
                      <input type="hidden" name="from" value="pricing" />
                      <button className="button button-large" type="submit" disabled={!configured}>Subscribe</button>
                    </form>
                  )}
                </div>
              </article>
            );
          })}
        </div>
        {!configured && signedIn ? <p className="pr-note">Plans aren’t available yet.</p> : null}
        {!signedIn ? <p className="pr-note">You’ll be asked to sign in first, and you come straight back here.</p> : null}
      </section>

      <section className="section pr-compare" id="packs">
        <div className="section-heading">
          <span className="section-kicker">What you pay</span>
          <h2>Every pack,<br />every plan</h2>
          <p>The same Ziks, at a price that drops with your plan.</p>
        </div>
        <div className="pr-table-wrap">
          <table className="pr-table">
            <thead>
              <tr>
                <th scope="col">Ziks pack</th>
                <th scope="col">Free</th>
                {ZIK_PLANS.map((plan) => <th scope="col" key={plan.id}>{plan.label} <small>{plan.discountPercent}% off</small></th>)}
              </tr>
            </thead>
            <tbody>
              {ZIK_PACKS.map((pack) => (
                <tr key={pack.id}>
                  <th scope="row">{pack.zik.toLocaleString('en-US')} Ziks</th>
                  <td>{formatUsd(zikToCents(pack.zik))}</td>
                  {ZIK_PLANS.map((plan) => <td key={plan.id}>{formatUsd(discountedCents(zikToCents(pack.zik), plan.discountPercent))}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section pr-faq" id="faq">
        <div className="section-heading">
          <span className="section-kicker">Questions</span>
          <h2>Before you subscribe</h2>
        </div>
        <div className="pr-faq-list">
          {FAQ.map((item) => (
            <details key={item.question}>
              <summary>{item.question}</summary>
              <p>{item.answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="closing-cta">
        <h2>Buy Ziks for less.</h2>
        <p>Start free and subscribe when it makes sense. Still weighing options? <Link href="/compare" style={{ textDecoration: 'underline' }}>Compare Ziki with other AI platforms.</Link></p>
        <div className="cta-pair">
          <Link className="button button-large" href={signedIn ? '/coins' : loginHref}>{signedIn ? 'Go to your Ziks' : 'Get started'} <Icon name="arrow" size={17} /></Link>
          <Link className="button button-large button-secondary" href="/how-it-works">How it works</Link>
        </div>
      </section>
    </MarketingPage>
  );
}
