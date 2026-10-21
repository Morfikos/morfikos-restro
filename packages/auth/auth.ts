export interface AuthOrganization {
  id: string;
  name: string;
  role: string;
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: string;
  organizations: AuthOrganization[];
  branches: string[];
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: AuthUser;
}

export interface RefreshResponse {
  accessToken: string;
  expiresIn: number;
}

export interface MessageResponse {
  message: string;
}