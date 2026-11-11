import Link from "next/link";

type Props = { productName: string; logoUrl: string | null; href?: string };

/** The product's name with the company's logo, or a lettered mark when there is no logo. */
export function Brand({ productName, logoUrl, href = "/" }: Props) {
  return (
    <Link href={href} className="flex flex-none items-center gap-2 text-foreground">
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- served per session by /branding/logo, not a static asset
        <img
          src={logoUrl}
          alt=""
          data-testid="brand-logo"
          className="h-[26px] w-auto max-w-28 object-contain"
        />
      ) : (
        <span
          aria-hidden="true"
          data-testid="brand-mark"
          className="grid size-[26px] place-items-center rounded-[7px] bg-primary text-sm font-bold text-primary-foreground"
        >
          {productName.trim().charAt(0).toUpperCase()}
        </span>
      )}
      <span data-testid="product-name" className="font-bold tracking-tight">
        {productName}
      </span>
    </Link>
  );
}
