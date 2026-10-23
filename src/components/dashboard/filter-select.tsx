import { Label } from "@/components/ui/label";

/** A labelled <select> for the GET filter forms on dashboard list pages (they work without JavaScript). */
export function FilterSelect({
  name,
  label,
  value,
  options,
}: {
  name: string;
  label: string;
  value: string | number | undefined;
  options: Array<{ value: string | number; label: string }>;
}) {
  const id = `filter-${name}`;
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="block text-xs text-stone-600">
        {label}
      </Label>
      <select
        id={id}
        name={name}
        defaultValue={value ?? ""}
        className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900"
      >
        {options.map((option) => (
          <option key={String(option.value)} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export const RANGE_OPTIONS = [
  { value: 7, label: "Last 7 days" },
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
  { value: 365, label: "Last 365 days" },
];

export const CHANNEL_OPTIONS = [
  { value: "", label: "All channels" },
  { value: "EMBED", label: "Website" },
  { value: "TEST", label: "Dashboard tests" },
];
