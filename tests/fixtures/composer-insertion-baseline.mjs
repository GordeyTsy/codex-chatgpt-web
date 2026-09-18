export default async function insertPlainTextIntoComposer(element, value) {
  if (document.activeElement !== element)
    element.focus();
  if (document.activeElement !== element)
    return !1;
  const selection = window.getSelection();
  if (!selection)
    return !1;
  if (!(selection.isCollapsed && selection.anchorNode !== null && element.contains(selection.anchorNode))) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(!1);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  if (!selection.isCollapsed || !selection.anchorNode || !element.contains(selection.anchorNode))
    return !1;
  const chunkSize = 65536;
  if (value.length <= chunkSize)
    return document.execCommand("insertText", !1, value);
  for (let offset = 0;offset < value.length; offset += chunkSize) {
    const chunk = value.slice(offset, offset + chunkSize);
    if (!document.execCommand("insertText", !1, chunk))
      return !1;
    await new Promise((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
  return !0;
};
