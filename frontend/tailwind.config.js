/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        // Deep sea blue + white theme. Token NAMES are unchanged from the
        // original build (paper/ink/rust/forest/gold) so every component
        // reskins from here; only the values moved.
        paper: "#F3F8FC",   // cool white page background
        ink: "#08304F",     // deep sea blue: text, headings, primary buttons
        rust: "#1B6FA8",    // ocean blue accent: links, focus rings, hover (5.4:1 on white)
        forest: "#1E7B5A",  // success states (kept green on purpose, for meaning)
        gold: "#C9962C",    // pending/attention accents
        danger: "#B3382C",  // errors and destructive actions (red, 5.9:1 on white)
        sky: "#8FD0F5",     // light blue for text on deep-sea backgrounds
        deep: "#04213A",    // darkest sea blue, for hero gradients
      },
      fontFamily: {
        display: ["Fraunces", "Georgia", "serif"],
        sans: ["IBM Plex Sans", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "monospace"],
      },
    },
  },
  plugins: [],
};
