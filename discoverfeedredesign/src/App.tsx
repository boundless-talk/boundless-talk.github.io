import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ThemeProvider } from './theme/ThemeContext';
import { Intro } from './pages/Intro';
import { Discover } from './pages/Discover';

function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Intro />} />
          <Route path="/discover" element={<Discover />} />
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
}

export default App;
