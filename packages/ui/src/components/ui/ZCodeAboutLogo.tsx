import piLogoUrl from "@/assets/pi_logo.svg";
import { cn } from "@/components/lib/utils.js";

export function ZCodeAboutLogo({ className }: { className?: string }) {
  return (
    <img src={piLogoUrl} alt="" className={cn("shrink-0", className)} draggable={false} />
  );
}

export function ZCodeWordmarkLogo({ className }: { className?: string }) {
  return <ZCodeAboutLogo className={className} />;
}
