import Link from "next/link";

import { Button } from "@/components/ui/button";

const CAPABILITIES = [
  {
    title: "Grounded in your business",
    body: "Upload FAQs, documents, and website content so your agent answers from what you actually tell it — not from guesses.",
  },
  {
    title: "Built Ghana-first",
    body: "Ghanaian English is the starting point. Twi, Ga, Ewe, and other local languages ship only after native-speaker validation — never advertised before they're proven.",
  },
  {
    title: "Usage you can see coming",
    body: "Every conversation is metered by tenant and agent, with warnings before you run out and hard limits so a bill never surprises you.",
  },
];

const PLANS = [
  { name: "Starter", price: "GHS 299", unit: "/month", minutes: "150 minutes included" },
  { name: "Growth", price: "GHS 799", unit: "/month", minutes: "500 minutes included" },
  { name: "Enterprise", price: "Custom", unit: "", minutes: "Custom allowance" },
];

export default function LandingPage() {
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-stone-200">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <span className="text-lg font-semibold tracking-tight">
            Sunleon <span className="text-amber-600">Voice</span>
          </span>
          <nav className="flex items-center gap-3">
            <Link href="/sign-in" className="text-sm font-medium text-stone-600 hover:text-stone-900">
              Sign in
            </Link>
            <Link href="/sign-up">
              <Button size="sm">Get started</Button>
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <section className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
          <div className="max-w-3xl">
            <p className="mb-4 inline-block rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium tracking-wide text-amber-800 uppercase">
              Early build — pilot stage
            </p>
            <h1 className="text-4xl font-semibold leading-[1.05] tracking-tight text-stone-950 sm:text-6xl">
              Give your business a voice agent that actually knows your business.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-8 text-stone-600">
              Sunleon Voice lets Ghanaian businesses configure an AI agent on their own knowledge,
              test it, and embed it on their website — with usage you can track from day one.
            </p>
            <div className="mt-10 flex flex-wrap items-center gap-4">
              <Link href="/sign-up">
                <Button size="lg">Create your workspace</Button>
              </Link>
              <Link href="/sign-in" className="text-sm font-medium text-stone-700 hover:text-stone-950">
                Already have an account? Sign in →
              </Link>
            </div>
          </div>
        </section>

        <section className="border-t border-stone-200 bg-white">
          <div className="mx-auto max-w-6xl px-6 py-16">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-700">
              What&apos;s real today
            </h2>
            <div className="mt-8 grid gap-10 sm:grid-cols-3">
              {CAPABILITIES.map((item) => (
                <div key={item.title}>
                  <h3 className="text-base font-semibold text-stone-950">{item.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-stone-600">{item.body}</p>
                </div>
              ))}
            </div>
            <p className="mt-10 max-w-2xl text-sm text-stone-500">
              Voice conversations, knowledge upload, and billing are being built in that order,
              in public phases — see the project&apos;s own roadmap and known limitations before you rely
              on anything not listed here yet.
            </p>
          </div>
        </section>

        <section className="border-t border-stone-200">
          <div className="mx-auto max-w-6xl px-6 py-16">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-700">
              Illustrative pricing
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-stone-500">
              Starting assumptions, not final numbers — plans and limits are configurable and will
              be tuned against real provider costs before launch.
            </p>
            <div className="mt-8 grid gap-6 sm:grid-cols-3">
              {PLANS.map((plan) => (
                <div
                  key={plan.name}
                  className="rounded-xl border border-stone-200 bg-white p-6 shadow-sm"
                >
                  <h3 className="text-sm font-semibold text-stone-500">{plan.name}</h3>
                  <p className="mt-2 text-2xl font-semibold text-stone-950">
                    {plan.price}
                    <span className="text-sm font-normal text-stone-500">{plan.unit}</span>
                  </p>
                  <p className="mt-2 text-sm text-stone-600">{plan.minutes}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-stone-200">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-8 text-sm text-stone-500 sm:flex-row sm:items-center sm:justify-between">
          <span>Sunleon Voice — built for Ghanaian businesses first.</span>
          <span>No testimonials, metrics, or certifications are claimed here until they&apos;re real.</span>
        </div>
      </footer>
    </div>
  );
}
