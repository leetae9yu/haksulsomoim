import { type MouseEvent, type ReactNode, useState } from "react";
import { messages } from "../renderer-state";

interface OfficialLinkProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly url: string;
}

export function OfficialLink({ children, className = "official-link", url }: OfficialLinkProps) {
  const [error, setError] = useState("");

  async function openSource(event: MouseEvent<HTMLAnchorElement>) {
    const opener = window.haksul.openOfficialSource;
    if (opener === undefined) return;
    event.preventDefault();
    setError("");
    try {
      await opener({ url });
    } catch {
      setError(messages.officialSourceFailed);
    }
  }

  return (
    <>
      <a
        className={className}
        href={url}
        onClick={(event) => void openSource(event)}
        rel="noreferrer"
        target="_blank"
      >
        {children}
      </a>
      {error.length > 0 && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
