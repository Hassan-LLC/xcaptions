import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { initVersionCheck } from './lib/version'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

initVersionCheck()