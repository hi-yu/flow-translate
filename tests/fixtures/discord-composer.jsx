import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createEditor, Node } from 'slate';
import { Slate, Editable, withReact } from 'slate-react';
import { withHistory } from 'slate-history';

function Composer() {
  const editor = useMemo(() => withHistory(withReact(createEditor())), []);
  const [value, setValue] = useState([
    {
      type: 'paragraph',
      children: [
        { text: new URL(location.href).searchParams.has('empty') ? '' : '你好，周五见。' },
      ],
    },
  ]);
  const [renders, setRenders] = useState(0);
  window.slateDraft = () => editor.children.map((node) => Node.string(node)).join('\n');
  window.sentDrafts ??= [];
  window.emojiClicks ??= 0;
  return (
    <form onSubmit={(event) => event.preventDefault()}>
      <div
        className="channelTextArea_fixture"
        style={{ display: 'flex', alignItems: 'center', gap: 8 }}
      >
        <Slate editor={editor} initialValue={value} onChange={setValue}>
          <Editable
            style={{ flex: 1, minWidth: 0 }}
            role="textbox"
            aria-label="Message engineering"
            aria-multiline="true"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                window.sentDrafts.push(window.slateDraft());
              }
            }}
          />
        </Slate>
        <div className="buttons_fixture" style={{ display: 'flex', alignItems: 'center' }}>
          <button
            id="native-emoji"
            type="button"
            aria-label="Add emoji"
            onClick={() => {
              window.emojiClicks++;
            }}
          >
            ☺
          </button>
          <button type="button" aria-label="GIF">
            GIF
          </button>
        </div>
      </div>
      <button type="button" id="composer-rerender" onClick={() => setRenders(renders + 1)}>
        Rerender editor
      </button>
      <output id="draft-model">{JSON.stringify(value)}</output>
    </form>
  );
}

createRoot(document.querySelector('#slate-compose-root')).render(<Composer />);
