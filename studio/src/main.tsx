import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import './styles.css'
import { Editor } from './App'
import { installKeys } from './keys'

installKeys()
createRoot(document.getElementById('root')!).render(<Editor />)
