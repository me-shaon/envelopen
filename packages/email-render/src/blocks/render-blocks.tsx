import type { CSSProperties, ReactNode } from "react";
import {
  Body,
  Button,
  Column,
  Container,
  Head,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Row,
  Section,
} from "react-email";
import { EMAIL_COLORS, EMAIL_CSS, EMAIL_FONT, EMAIL_WIDTH } from "../layout";
import { mergeTagText } from "../merge-tags";
import {
  type Align,
  type BlockNode,
  type ColumnChild,
  DEFAULT_BUTTON,
  type EmailDocument,
  type InlineNode,
  type SocialLink,
} from "./types";

// React Email components for each block (KTD26). They run in the browser at save time
// and in the Node tests, never in the Worker. Missing attributes fall back to defaults,
// so an old document still renders.

const text: CSSProperties = {
  margin: "0 0 16px",
  fontSize: "16px",
  lineHeight: "1.6",
  color: EMAIL_COLORS.text,
};

const HEADING_SIZES = { 1: "28px", 2: "22px", 3: "18px" } as const;

const SOCIAL_LABELS: Record<SocialLink["network"], string> = {
  website: "Website",
  x: "X",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  facebook: "Facebook",
  youtube: "YouTube",
  github: "GitHub",
};

function align(value: unknown): Align {
  return value === "center" || value === "right" ? value : "left";
}

function color(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value) ? value : fallback;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function Inline({ nodes }: { nodes: InlineNode[] | undefined }): ReactNode {
  return (nodes ?? []).map((node, index) => {
    const key = `${index}`;
    if (node.type === "hardBreak") return <br key={key} />;
    if (node.type === "mergeTag") {
      return mergeTagText(str(node.attrs?.field) || "first_name", str(node.attrs?.fallback));
    }
    let out: ReactNode = node.text;
    for (const mark of node.marks ?? []) {
      if (mark.type === "bold") out = <strong>{out}</strong>;
      else if (mark.type === "italic") out = <em>{out}</em>;
      else if (mark.type === "underline") out = <u>{out}</u>;
      else if (mark.type === "strike") out = <s>{out}</s>;
      else if (mark.type === "link") {
        out = (
          <Link
            className="env-link"
            href={str(mark.attrs?.href)}
            style={{ color: EMAIL_COLORS.link }}
          >
            {out}
          </Link>
        );
      }
    }
    return <span key={key}>{out}</span>;
  });
}

function Block({ node }: { node: BlockNode | ColumnChild }): ReactNode {
  switch (node.type) {
    case "heading": {
      const level = node.attrs?.level === 1 || node.attrs?.level === 3 ? node.attrs.level : 2;
      const Tag = `h${level}` as const;
      return (
        <Tag
          style={{
            ...text,
            margin: "0 0 12px",
            fontSize: HEADING_SIZES[level],
            lineHeight: "1.25",
            fontWeight: 600,
            letterSpacing: "-0.02em",
          }}
        >
          <Inline nodes={node.content} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p style={text}>{node.content?.length ? <Inline nodes={node.content} /> : "\u00a0"}</p>
      );
    case "image": {
      const src = str(node.attrs?.src);
      if (!src) return null;
      const width = Math.min(Math.max(Number(node.attrs?.width) || EMAIL_WIDTH, 40), EMAIL_WIDTH);
      const image = (
        <Img
          src={src}
          alt={str(node.attrs?.alt)}
          width={width}
          style={{ display: "inline-block", maxWidth: "100%", height: "auto", borderRadius: "8px" }}
        />
      );
      const href = str(node.attrs?.href);
      return (
        <Section style={{ margin: "0 0 16px", textAlign: align(node.attrs?.align) }}>
          {href ? <Link href={href}>{image}</Link> : image}
        </Section>
      );
    }
    case "button": {
      const attrs = node.attrs ?? DEFAULT_BUTTON;
      const background = color(attrs.background, DEFAULT_BUTTON.background);
      const isDefault = background.toLowerCase() === DEFAULT_BUTTON.background;
      return (
        <Section style={{ margin: "8px 0 24px", textAlign: align(node.attrs?.align) }}>
          <Button
            className={isDefault ? "env-button-default" : undefined}
            href={str(node.attrs?.href)}
            style={{
              display: "inline-block",
              padding: "12px 22px",
              borderRadius: "9px",
              fontSize: "15px",
              fontWeight: 600,
              textDecoration: "none",
              background,
              color: color(attrs.color, DEFAULT_BUTTON.color),
            }}
          >
            {str(node.attrs?.label) || "Button"}
          </Button>
        </Section>
      );
    }
    case "divider":
      return (
        <Hr
          className="env-hr"
          style={{
            margin: "24px 0",
            border: "none",
            borderTop: `1px solid ${EMAIL_COLORS.border}`,
          }}
        />
      );
    case "spacer": {
      const height = Math.min(Math.max(Number(node.attrs?.height) || 24, 4), 160);
      return (
        <Section style={{ height: `${height}px`, lineHeight: `${height}px`, fontSize: "1px" }}>
          {"\u00a0"}
        </Section>
      );
    }
    case "columns": {
      const columns = (node.content ?? []).slice(0, 2);
      return (
        <Section style={{ margin: "0 0 8px" }}>
          <Row>
            {columns.map((column, index) => (
              <Column
                // biome-ignore lint/suspicious/noArrayIndexKey: the two columns never reorder.
                key={index}
                className="env-col"
                width="50%"
                style={{
                  width: "50%",
                  verticalAlign: "top",
                  paddingLeft: index === 0 ? 0 : "12px",
                  paddingRight: index === 0 ? "12px" : 0,
                }}
              >
                {(column.content ?? []).map((child, childIndex) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static output, rendered once.
                  <Block key={childIndex} node={child} />
                ))}
              </Column>
            ))}
          </Row>
        </Section>
      );
    }
    case "social": {
      const links = Array.isArray(node.attrs?.links) ? node.attrs.links : [];
      return (
        <Section style={{ margin: "8px 0 16px", textAlign: align(node.attrs?.align) }}>
          {links
            .filter((link) => str(link.url))
            .map((link, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static output, rendered once.
              <span key={index}>
                {index > 0 ? (
                  <span className="env-muted" style={{ color: EMAIL_COLORS.muted }}>
                    {" "}
                    ·{" "}
                  </span>
                ) : null}
                <Link
                  className="env-link"
                  href={link.url}
                  style={{ color: EMAIL_COLORS.link, fontSize: "14px" }}
                >
                  {SOCIAL_LABELS[link.network] ?? "Link"}
                </Link>
              </span>
            ))}
        </Section>
      );
    }
    case "footer":
      return (
        <Section
          className="env-muted env-footer"
          style={{
            marginTop: "24px",
            paddingTop: "16px",
            borderTop: `1px solid ${EMAIL_COLORS.border}`,
            fontSize: "13px",
            lineHeight: "1.5",
            color: EMAIL_COLORS.muted,
          }}
        >
          <p
            className="env-muted"
            style={{ margin: "0 0 8px", color: EMAIL_COLORS.muted, whiteSpace: "pre-line" }}
          >
            {str(node.attrs?.text)}
          </p>
          <p className="env-muted" style={{ margin: 0, color: EMAIL_COLORS.muted }}>
            <Link
              href="{{ unsubscribe_url }}"
              style={{ color: EMAIL_COLORS.muted, textDecoration: "underline" }}
            >
              Unsubscribe
            </Link>
            {" · "}
            <Link
              href="{{ preferences_url }}"
              style={{ color: EMAIL_COLORS.muted, textDecoration: "underline" }}
            >
              Email preferences
            </Link>
          </p>
        </Section>
      );
    case "html":
      // The Worker sanitizes the whole email when the template is saved (KTD27).
      // biome-ignore lint/security/noDangerouslySetInnerHtml: raw HTML is this block's purpose.
      return <div dangerouslySetInnerHTML={{ __html: str(node.attrs?.html) }} />;
    default:
      return null;
  }
}

/** The blocks without the email frame. Saved block previews and tests use it. */
export function Blocks({ nodes }: { nodes: readonly (BlockNode | ColumnChild)[] }): ReactNode {
  return nodes.map((node, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: static output, rendered once.
    <Block key={index} node={node} />
  ));
}

/** The whole email: head, preheader, page, and card. */
export function EmailTemplate({
  doc,
  preheader,
}: {
  doc: EmailDocument;
  preheader?: string | null | undefined;
}) {
  return (
    <Html lang="en">
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: fixed CSS from layout.ts. */}
        <style dangerouslySetInnerHTML={{ __html: EMAIL_CSS }} />
      </Head>
      {preheader ? <Preview>{preheader}</Preview> : null}
      {/* React Email moves Body styles to an inner cell, out of reach of the dark-mode
          class, so the page color sits on a section with the class. */}
      <Body className="env-page" style={{ margin: 0, padding: 0, background: EMAIL_COLORS.page }}>
        <Section
          className="env-page"
          style={{ padding: "32px 12px", background: EMAIL_COLORS.page }}
        >
          <Container
            className="env-card"
            width={EMAIL_WIDTH}
            style={{
              width: `${EMAIL_WIDTH}px`,
              maxWidth: "100%",
              background: EMAIL_COLORS.card,
              border: `1px solid ${EMAIL_COLORS.border}`,
              borderRadius: "12px",
            }}
          >
            <Section
              className="env-pad env-text"
              style={{ padding: "36px 40px", fontFamily: EMAIL_FONT }}
            >
              <Blocks nodes={doc.content ?? []} />
            </Section>
          </Container>
        </Section>
      </Body>
    </Html>
  );
}
