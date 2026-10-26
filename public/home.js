document.querySelector('[data-new-trip]')?.addEventListener('click', () => document.getElementById('new-dialog').showModal());
for (const button of document.querySelectorAll('[data-close-dialog]')) {
  button.addEventListener('click', () => button.closest('dialog').close());
}
for (const form of document.querySelectorAll('[data-clone-source]')) {
  form.addEventListener('submit', event => {
    event.preventDefault();
    const dialog = document.getElementById('clone-dialog');
    dialog.querySelector('[name="source"]').value = form.dataset.cloneSource;
    dialog.querySelector('[name="slug"]').value = `${form.dataset.cloneSource}-variation`;
    dialog.showModal();
  });
}
