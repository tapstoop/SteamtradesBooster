export function createSearchBar({
  placeholder = 'Search...',
  onSearch,
  containerClass = 'stpt-ws-search',
  inputClass = 'stpt-ws-search-input',
  inputId = '',
} = {}) {
  const container = document.createElement('div');
  container.className = containerClass;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = inputClass;
  if (inputId) input.id = inputId;
  input.placeholder = placeholder;

  let timeout = null;
  input.addEventListener('input', e => {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      onSearch?.(e.target.value);
    }, 200);
  });

  container.appendChild(input);
  return container;
}
