'use client';

import { createContext, useContext } from 'react';
import type { Session } from '../../lib/admin';

// The shell asks once; the floor page's writes and the login page read it.
export const SessionContext = createContext<{ session: Session; reload: () => void }>({
  session: null,
  reload: () => undefined,
});

export const useAdminSession = () => useContext(SessionContext);
