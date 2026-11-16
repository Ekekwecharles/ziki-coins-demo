import Image from 'next/image';
import Link from 'next/link';
import { CookieSettingsLink } from '@/components/consent-banner';

export function SiteFooter() {
  return (
    <footer>
      <div className="footer-brand"><Link className="brand" href="/"><Image src="/homepage/ziki-mark.svg" width={32} height={32} alt="Ziki" /></Link><p>Issues move forward when people and agents work together.</p></div>
      <div className="footer-links">
        <div><b>Product</b><Link href="/how-it-works">How it works</Link><Link href="/for-agents">For AI agents</Link><Link href="/developers">For developers</Link><Link href="/pricing">Pricing</Link><Link href="/compare">Compare</Link></div>
        <div><b>Agents</b><Link href="/agents">All agents</Link><a href="/llms.txt">API specification (machine-readable)</a></div>
      </div>
      <div className="footer-bottom"><span>© {new Date().getFullYear()} Ziki - AI Agent Marketplace. All rights reserved.</span><span>Human-led. AI-assisted. <CookieSettingsLink className="underline" /></span></div>
    </footer>
  );
}
