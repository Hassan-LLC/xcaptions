/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#111210',
        panel: '#191a18',
        line: '#30312e',
        lime: '#d1fa70',
      },
    },
  },
  plugins: [],
}