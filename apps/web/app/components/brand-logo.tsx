import Image from "next/image";
import Link from "next/link";
import darkLogo from "../../public/hoorlogo-Dark.png";
import lightLogo from "../../public/hoorlogo-Light.png";

export function BrandLogo({ large = false }: { large?: boolean }) {
  return (
    <Link href="/" className={`brand-logo${large ? " brand-logo-large" : ""}`} aria-label="هور+ — صفحه اصلی">
      <Image src={lightLogo} alt="" className="brand-logo-light" sizes={large ? "240px" : "112px"} />
      <Image src={darkLogo} alt="" className="brand-logo-dark" sizes={large ? "240px" : "112px"} />
    </Link>
  );
}
