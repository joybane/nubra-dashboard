/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: ['attribute', '[data-theme]'],
  theme: {
    extend: {
      colors: {
        'bg-primary':    'var(--bg-primary)',
        'bg-secondary':  'var(--bg-secondary)',
        'bg-card':       'var(--bg-card)',
        'bg-hover':      'var(--bg-hover)',
        border:          'var(--border)',
        accent:          'var(--accent)',
        'accent-dim':    'var(--accent-dim)',
        green:           'var(--green)',
        red:             'var(--red)',
        'text-primary':  'var(--text-primary)',
        'text-secondary':'var(--text-secondary)',
        'text-muted':    'var(--text-muted)',
      },
      fontFamily: {
        sans: ["'Inter'", "'Segoe UI'", 'sans-serif'],
      },
    },
  },
  plugins: [require('daisyui')],
  daisyui: {
    themes: false,
    base: false,
    styled: true,
    utils: true,
    prefix: 'dui-',
  },
};
