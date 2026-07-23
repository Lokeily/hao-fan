import { collectTextBlocks, textOfBlock } from '../../utils/dom';

const texts = collectTextBlocks(document.body).map(textOfBlock);
const processedParent = document.createElement('section');
processedParent.className = 'ot-translated';
const newlyLoaded = document.createElement('p');
newlyLoaded.textContent = 'New content loaded inside an already translated container.';
processedParent.appendChild(newlyLoaded);
document.querySelector('main')?.appendChild(processedParent);
const dynamicTexts = collectTextBlocks(document.body).map(textOfBlock);
const result = document.getElementById('result');
if (result) {
  result.dataset.texts = JSON.stringify(texts);
  result.dataset.navExcluded = String(!texts.some((text) => text.includes('Open menu')));
  result.dataset.sideNavIncluded = String(
    texts.some((text) => text === 'Home') &&
    texts.some((text) => text === 'All issues') &&
    texts.some((text) => text === 'All repositories'),
  );
  result.dataset.closeControlExcluded = String(!texts.some((text) => text.includes('Close menu')));
  result.dataset.chromeMenuExcluded = String(!texts.some((text) => text.includes('Profile settings')));
  result.dataset.formIncluded = String(
    texts.some((text) => text.includes('Authenticator apps')) &&
    texts.some((text) => text.includes('Alternative recovery options')),
  );
  result.dataset.menuIncluded = String(
    texts.some((text) => text.includes('Anyone on the internet')) &&
    texts.some((text) => text.includes('You choose who can see')),
  );
  result.dataset.processedDescendantIncluded = String(
    dynamicTexts.some((text) => text.includes('New content loaded')),
  );
}
