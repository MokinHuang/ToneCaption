import { useEffect, useState } from 'react'
import { HomePage } from './pages/HomePage'
import { ClassroomPage } from './pages/ClassroomPage'
import { sampleClassroomSession } from './data/sampleClassroom'

type Route = 'home' | 'classroom'

function routeFromHash(): Route {
  return window.location.hash === '#/classroom' ? 'classroom' : 'home'
}

export default function App() {
  const [route, setRoute] = useState<Route>(routeFromHash)

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const go = (r: Route) => {
    window.location.hash = r === 'classroom' ? '#/classroom' : '#/'
  }

  return (
    <div className="app-shell">
      {route === 'classroom' ? (
        <ClassroomPage
          session={sampleClassroomSession}
          onBackHome={() => go('home')}
        />
      ) : (
        <HomePage onEnterClassroom={() => go('classroom')} />
      )}
    </div>
  )
}