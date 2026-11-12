import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Props = React.ComponentProps<typeof Input> & { label: string; name: string; hint?: string };

/**
 * A labelled text input. Its id is its name unless one is given; give one when two forms on the
 * same screen have a field of the same name.
 */
export function Field({ label, name, hint, id = name, ...input }: Props) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={name} {...input} />
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
