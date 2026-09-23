import { memo, type ReactNode } from 'react';
import Linkify from 'linkify-react';
import { parseMessageBody, type MessageNode } from '../../utils/messageFormatter';

interface Props {
  text: string;
  className?: string;
  enableLinks?: boolean;
}

const linkifyOptions = {
  target: '_blank',
  rel: 'noopener noreferrer',
  defaultProtocol: 'https',
  // 'bdi' isolates a resolved @mention (see the 'mention' case below) from Linkify: a push name
  // is attacker-controlled text, and linkify-react auto-links a bare word with no scheme (e.g.
  // "localhost"), so character-stripping the name is not enough — keeping it out of Linkify's own
  // tree walk is what stops it. 'bdi' also isolates a right-to-left name's directionality.
  ignoreTags: ['code', 'pre', 'bdi'],
  attributes: {
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
  },
};

function renderNode(node: MessageNode, key: number): ReactNode {
  switch (node.type) {
    case 'text':
      return <span key={key}>{node.value}</span>;
    case 'bold':
      return <strong key={key}>{node.children.map(renderNode)}</strong>;
    case 'italic':
      return <em key={key}>{node.children.map(renderNode)}</em>;
    case 'strike':
      return <s key={key}>{node.children.map(renderNode)}</s>;
    case 'code':
      return <code key={key}>{node.value}</code>;
    case 'codeblock':
      return (
        <pre key={key}>
          <code>{node.value}</code>
        </pre>
      );
    case 'mention':
      return <bdi key={key}>{node.value}</bdi>;
  }
}

function MessageBodyBase({ text, className, enableLinks = true }: Props) {
  const nodes = parseMessageBody(text);
  const rendered = <>{nodes.map(renderNode)}</>;
  return (
    <div className={className}>{enableLinks ? <Linkify options={linkifyOptions}>{rendered}</Linkify> : rendered}</div>
  );
}

export default memo(MessageBodyBase);
