import type { IconMeta } from "@/lib/desktop-config";
import { GalleryApp } from "@/components/gallery/gallery-app";
import { PageShell } from "./ui/page-shell";

type PhonePlaceholderAppProps = {
    icon: IconMeta;
    onClose: () => void;
};

export function PhonePlaceholderApp({ icon, onClose }: PhonePlaceholderAppProps) {
    if (icon.id === "gallery") {
        return <GalleryApp onClose={onClose} />;
    }

    return (
        <PageShell title={icon.label} onBack={onClose}>
            <div className="flex justify-center items-center h-[60%] opacity-50 ts-15">
                功能开发中
            </div>
        </PageShell>
    );
}
