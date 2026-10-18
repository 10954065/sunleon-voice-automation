import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center bg-stone-50 px-6 py-16">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 block text-center text-lg font-semibold tracking-tight">
          Sunleon <span className="text-amber-600">Voice</span>
        </Link>
        {children}
      </div>
    </div>
  );
}
